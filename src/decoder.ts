import { assert, fail } from "./goog/asserts";
import { byteArrayToString } from "./goog/crypt";
import {
  byteSourceToUint8Array,
  joinFloat32,
  joinFloat64,
  joinHash64,
  joinInt64,
  joinSignedDecimalString,
  joinUint64,
  joinUnsignedDecimalString,
  joinZigzag64,
} from "./utils";

/**
 * BinaryDecoder implements the decoders for all the wire types specified in
 * https://developers.google.com/protocol-buffers/docs/encoding.
 *
 * @param {ByteSource=} opt_bytes The bytes we're reading from.
 * @param {number=} opt_start The optional offset to start reading at.
 * @param {number=} opt_length The optional length of the block to read -
 *     we'll throw an assertion if we go off the end of the block.
 * @constructor
 * @struct
 */
export const BinaryDecoder = function (opt_bytes, opt_start, opt_length) {
  /**
   * Typed byte-wise view of the source buffer.
   * @private {?Uint8Array}
   */
  this.bytes_ = null;

  /**
   * Start point of the block to read.
   * @private {number}
   */
  this.start_ = 0;

  /**
   * End point of the block to read.
   * @private {number}
   */
  this.end_ = 0;

  /**
   * Current read location in bytes_.
   * @private {number}
   */
  this.cursor_ = 0;

  /**
   * Set to true if this decoder encountered an error due to corrupt data.
   * @private {boolean}
   */
  this.error_ = false;

  if (opt_bytes) {
    this.setBlock(opt_bytes, opt_start, opt_length);
  }
};

/**
 * Global pool of BinaryDecoder instances.
 * @private {!Array<!BinaryDecoder>}
 */
BinaryDecoder.instanceCache_ = [];

/**
 * Pops an instance off the instance cache, or creates one if the cache is
 * empty.
 * @param {ByteSource=} opt_bytes The bytes we're reading from.
 * @param {number=} opt_start The optional offset to start reading at.
 * @param {number=} opt_length The optional length of the block to read -
 *     we'll throw an assertion if we go off the end of the block.
 * @return {!BinaryDecoder}
 */
BinaryDecoder.alloc = function (opt_bytes, opt_start, opt_length) {
  if (BinaryDecoder.instanceCache_.length) {
    const newDecoder = BinaryDecoder.instanceCache_.pop();
    if (opt_bytes) {
      newDecoder.setBlock(opt_bytes, opt_start, opt_length);
    }
    return newDecoder;
  } else {
    return new BinaryDecoder(opt_bytes, opt_start, opt_length);
  }
};

/**
 * Puts this instance back in the instance cache.
 */
BinaryDecoder.prototype.free = function () {
  this.clear();
  if (BinaryDecoder.instanceCache_.length < 100) {
    BinaryDecoder.instanceCache_.push(this);
  }
};

/**
 * Makes a copy of this decoder.
 * @return {!BinaryDecoder}
 */
BinaryDecoder.prototype.clone = function () {
  return BinaryDecoder.alloc(this.bytes_, this.start_, this.end_ - this.start_);
};

/**
 * Clears the decoder.
 */
BinaryDecoder.prototype.clear = function () {
  this.bytes_ = null;
  this.start_ = 0;
  this.end_ = 0;
  this.cursor_ = 0;
  this.error_ = false;
};

/**
 * Returns the raw buffer.
 * @return {?Uint8Array} The raw buffer.
 */
BinaryDecoder.prototype.getBuffer = function () {
  return this.bytes_;
};

/**
 * Changes the block of bytes we're decoding.
 * @param {!ByteSource} data The bytes we're reading from.
 * @param {number=} opt_start The optional offset to start reading at.
 * @param {number=} opt_length The optional length of the block to read -
 *     we'll throw an assertion if we go off the end of the block.
 */
BinaryDecoder.prototype.setBlock = function (data, opt_start, opt_length) {
  this.bytes_ = byteSourceToUint8Array(data);
  this.start_ = opt_start !== undefined ? opt_start : 0;
  this.end_ =
    opt_length !== undefined ? this.start_ + opt_length : this.bytes_.length;
  this.cursor_ = this.start_;
};

/**
 * @return {number}
 */
BinaryDecoder.prototype.getEnd = function () {
  return this.end_;
};

/**
 * @param {number} end
 */
BinaryDecoder.prototype.setEnd = function (end) {
  this.end_ = end;
};

/**
 * Moves the read cursor back to the start of the block.
 */
BinaryDecoder.prototype.reset = function () {
  this.cursor_ = this.start_;
};

/**
 * Returns the internal read cursor.
 * @return {number} The internal read cursor.
 */
BinaryDecoder.prototype.getCursor = function () {
  return this.cursor_;
};

/**
 * Returns the internal read cursor.
 * @param {number} cursor The new cursor.
 */
BinaryDecoder.prototype.setCursor = function (cursor) {
  this.cursor_ = cursor;
};

/**
 * Advances the stream cursor by the given number of bytes.
 * @param {number} count The number of bytes to advance by.
 */
BinaryDecoder.prototype.advance = function (count) {
  this.cursor_ += count;
  assert(this.cursor_ <= this.end_);
};

/**
 * Returns true if this decoder is at the end of the block.
 * @return {boolean}
 */
BinaryDecoder.prototype.atEnd = function () {
  return this.cursor_ == this.end_;
};

/**
 * Returns true if this decoder is at the end of the block.
 * @return {boolean}
 */
BinaryDecoder.prototype.pastEnd = function () {
  return this.cursor_ > this.end_;
};

/**
 * Returns true if this decoder encountered an error due to corrupt data.
 * @return {boolean}
 */
BinaryDecoder.prototype.getError = function () {
  return this.error_ || this.cursor_ < 0 || this.cursor_ > this.end_;
};

/**
 * Reads an unsigned varint from the binary stream and invokes the conversion
 * function with the value in two signed 32 bit integers to produce the result.
 * Since this does not convert the value to a number, no precision is lost.
 *
 * It's possible for an unsigned varint to be incorrectly encoded - more than
 * 64 bits' worth of data could be present. If this happens, this method will
 * throw an error.
 *
 * Decoding varints requires doing some funny base-128 math - for more
 * details on the format, see
 * https://developers.google.com/protocol-buffers/docs/encoding
 *
 * @param {function(number, number): T} convert Conversion function to produce
 *     the result value, takes parameters (lowBits, highBits).
 * @return {T}
 * @template T
 */
BinaryDecoder.prototype.readSplitVarint64 = function (convert) {
  let temp = 128;
  let lowBits = 0;
  let highBits = 0;

  // Read the first four bytes of the varint, stopping at the terminator if we
  // see it.
  for (var i = 0; i < 4 && temp >= 128; i++) {
    temp = this.bytes_[this.cursor_++];
    lowBits |= (temp & 0x7f) << (i * 7);
  }

  if (temp >= 128) {
    // Read the fifth byte, which straddles the low and high dwords.
    temp = this.bytes_[this.cursor_++];
    lowBits |= (temp & 0x7f) << 28;
    highBits |= (temp & 0x7f) >> 4;
  }

  if (temp >= 128) {
    // Read the sixth through tenth byte.
    for (var i = 0; i < 5 && temp >= 128; i++) {
      temp = this.bytes_[this.cursor_++];
      highBits |= (temp & 0x7f) << (i * 7 + 3);
    }
  }

  if (temp < 128) {
    return convert(lowBits >>> 0, highBits >>> 0);
  }

  // If we did not see the terminator, the encoding was invalid.
  fail("Failed to read varint, encoding is invalid.");
  this.error_ = true;
};

/**
 * Reads a 64-bit fixed-width value from the stream and invokes the conversion
 * function with the value in two signed 32 bit integers to produce the result.
 * Since this does not convert the value to a number, no precision is lost.
 *
 * @param {function(number, number): T} convert Conversion function to produce
 *     the result value, takes parameters (lowBits, highBits).
 * @return {T}
 * @template T
 */
BinaryDecoder.prototype.readSplitFixed64 = function (convert) {
  const bytes = this.bytes_;
  const cursor = this.cursor_;
  this.cursor_ += 8;
  let lowBits = 0;
  let highBits = 0;
  for (let i = cursor + 7; i >= cursor; i--) {
    lowBits = (lowBits << 8) | bytes[i];
    highBits = (highBits << 8) | bytes[i + 4];
  }
  return convert(lowBits, highBits);
};

/**
 * Skips over a varint in the block without decoding it.
 */
BinaryDecoder.prototype.skipVarint = function () {
  while (this.bytes_[this.cursor_] & 0x80) {
    this.cursor_++;
  }
  this.cursor_++;
};

/**
 * Skips backwards over a varint in the block - to do this correctly, we have
 * to know the value we're skipping backwards over or things are ambiguous.
 * @param {number} value The varint value to unskip.
 */
BinaryDecoder.prototype.unskipVarint = function (value) {
  while (value > 128) {
    this.cursor_--;
    value = value >>> 7;
  }
  this.cursor_--;
};

/**
 * Reads a 32-bit varint from the binary stream. Due to a quirk of the encoding
 * format and Javascript's handling of bitwise math, this actually works
 * correctly for both signed and unsigned 32-bit varints.
 *
 * This function is called vastly more frequently than any other in
 * BinaryDecoder, so it has been unrolled and tweaked for performance.
 *
 * If there are more than 32 bits of data in the varint, it _must_ be due to
 * sign-extension. If we're in debug mode and the high 32 bits don't match the
 * expected sign extension, this method will throw an error.
 *
 * Decoding varints requires doing some funny base-128 math - for more
 * details on the format, see
 * https://developers.google.com/protocol-buffers/docs/encoding
 *
 * @return {number} The decoded unsigned 32-bit varint.
 */
BinaryDecoder.prototype.readUnsignedVarint32 = function () {
  let temp;
  const bytes = this.bytes_;

  temp = bytes[this.cursor_ + 0];
  let x = temp & 0x7f;
  if (temp < 128) {
    this.cursor_ += 1;
    assert(this.cursor_ <= this.end_);
    return x;
  }

  temp = bytes[this.cursor_ + 1];
  x |= (temp & 0x7f) << 7;
  if (temp < 128) {
    this.cursor_ += 2;
    assert(this.cursor_ <= this.end_);
    return x;
  }

  temp = bytes[this.cursor_ + 2];
  x |= (temp & 0x7f) << 14;
  if (temp < 128) {
    this.cursor_ += 3;
    assert(this.cursor_ <= this.end_);
    return x;
  }

  temp = bytes[this.cursor_ + 3];
  x |= (temp & 0x7f) << 21;
  if (temp < 128) {
    this.cursor_ += 4;
    assert(this.cursor_ <= this.end_);
    return x;
  }

  temp = bytes[this.cursor_ + 4];
  x |= (temp & 0x0f) << 28;
  if (temp < 128) {
    // We're reading the high bits of an unsigned varint. The byte we just read
    // also contains bits 33 through 35, which we're going to discard.
    this.cursor_ += 5;
    assert(this.cursor_ <= this.end_);
    return x >>> 0;
  }

  // If we get here, we need to truncate coming bytes. However we need to make
  // sure cursor place is correct.
  this.cursor_ += 5;
  if (
    bytes[this.cursor_++] >= 128 &&
    bytes[this.cursor_++] >= 128 &&
    bytes[this.cursor_++] >= 128 &&
    bytes[this.cursor_++] >= 128 &&
    bytes[this.cursor_++] >= 128
  ) {
    // If we get here, the varint is too long.
    assert(false);
  }

  assert(this.cursor_ <= this.end_);
  return x;
};

/**
 * The readUnsignedVarint32 above deals with signed 32-bit varints correctly,
 * so this is just an alias.
 *
 * @return {number} The decoded signed 32-bit varint.
 */
BinaryDecoder.prototype.readSignedVarint32 =
  BinaryDecoder.prototype.readUnsignedVarint32;

/**
 * Reads a 32-bit unsigned variant and returns its value as a string.
 *
 * @return {string} The decoded unsigned 32-bit varint as a string.
 */
BinaryDecoder.prototype.readUnsignedVarint32String = function () {
  // 32-bit integers fit in JavaScript numbers without loss of precision, so
  // string variants of 32-bit varint readers can simply delegate then convert
  // to string.
  const value = this.readUnsignedVarint32();
  return value.toString();
};

/**
 * Reads a 32-bit signed variant and returns its value as a string.
 *
 * @return {string} The decoded signed 32-bit varint as a string.
 */
BinaryDecoder.prototype.readSignedVarint32String = function () {
  // 32-bit integers fit in JavaScript numbers without loss of precision, so
  // string variants of 32-bit varint readers can simply delegate then convert
  // to string.
  const value = this.readSignedVarint32();
  return value.toString();
};

/**
 * Reads a signed, zigzag-encoded 32-bit varint from the binary stream.
 *
 * Zigzag encoding is a modification of varint encoding that reduces the
 * storage overhead for small negative integers - for more details on the
 * format, see https://developers.google.com/protocol-buffers/docs/encoding
 *
 * @return {number} The decoded signed, zigzag-encoded 32-bit varint.
 */
BinaryDecoder.prototype.readZigzagVarint32 = function () {
  const result = this.readUnsignedVarint32();
  return (result >>> 1) ^ -(result & 1);
};

/**
 * Reads an unsigned 64-bit varint from the binary stream. Note that since
 * Javascript represents all numbers as double-precision floats, there will be
 * precision lost if the absolute value of the varint is larger than 2^53.
 *
 * @return {number} The decoded unsigned varint. Precision will be lost if the
 *     integer exceeds 2^53.
 */
BinaryDecoder.prototype.readUnsignedVarint64 = function () {
  return this.readSplitVarint64(joinUint64);
};

/**
 * Reads an unsigned 64-bit varint from the binary stream and returns the value
 * as a decimal string.
 *
 * @return {string} The decoded unsigned varint as a decimal string.
 */
BinaryDecoder.prototype.readUnsignedVarint64String = function () {
  return this.readSplitVarint64(joinUnsignedDecimalString);
};

/**
 * Reads a signed 64-bit varint from the binary stream. Note that since
 * Javascript represents all numbers as double-precision floats, there will be
 * precision lost if the absolute value of the varint is larger than 2^53.
 *
 * @return {number} The decoded signed varint. Precision will be lost if the
 *     integer exceeds 2^53.
 */
BinaryDecoder.prototype.readSignedVarint64 = function () {
  return this.readSplitVarint64(joinInt64);
};

/**
 * Reads an signed 64-bit varint from the binary stream and returns the value
 * as a decimal string.
 *
 * @return {string} The decoded signed varint as a decimal string.
 */
BinaryDecoder.prototype.readSignedVarint64String = function () {
  return this.readSplitVarint64(joinSignedDecimalString);
};

/**
 * Reads a signed, zigzag-encoded 64-bit varint from the binary stream. Note
 * that since Javascript represents all numbers as double-precision floats,
 * there will be precision lost if the absolute value of the varint is larger
 * than 2^53.
 *
 * Zigzag encoding is a modification of varint encoding that reduces the
 * storage overhead for small negative integers - for more details on the
 * format, see https://developers.google.com/protocol-buffers/docs/encoding
 *
 * @return {number} The decoded zigzag varint. Precision will be lost if the
 *     integer exceeds 2^53.
 */
BinaryDecoder.prototype.readZigzagVarint64 = function () {
  return this.readSplitVarint64(joinZigzag64);
};

/**
 * Reads a signed, zigzag-encoded 64-bit varint from the binary stream
 * losslessly and returns it as an 8-character Unicode string for use as a hash
 * table key.
 *
 * Zigzag encoding is a modification of varint encoding that reduces the
 * storage overhead for small negative integers - for more details on the
 * format, see https://developers.google.com/protocol-buffers/docs/encoding
 *
 * @return {string} The decoded zigzag varint in hash64 format.
 */
BinaryDecoder.prototype.readZigzagVarintHash64 = function () {
  return this.readSplitZigzagVarint64(joinHash64);
};

/**
 * Reads a signed, zigzag-encoded 64-bit varint from the binary stream and
 * returns its value as a string.
 *
 * Zigzag encoding is a modification of varint encoding that reduces the
 * storage overhead for small negative integers - for more details on the
 * format, see https://developers.google.com/protocol-buffers/docs/encoding
 *
 * @return {string} The decoded signed, zigzag-encoded 64-bit varint as a
 * string.
 */
BinaryDecoder.prototype.readZigzagVarint64String = function () {
  return this.readSplitZigzagVarint64(joinSignedDecimalString);
};

/**
 * Reads a raw unsigned 8-bit integer from the binary stream.
 *
 * @return {number} The unsigned 8-bit integer read from the binary stream.
 */
BinaryDecoder.prototype.readUint8 = function () {
  const a = this.bytes_[this.cursor_ + 0];
  this.cursor_ += 1;
  assert(this.cursor_ <= this.end_);
  return a;
};

/**
 * Reads a raw unsigned 16-bit integer from the binary stream.
 *
 * @return {number} The unsigned 16-bit integer read from the binary stream.
 */
BinaryDecoder.prototype.readUint16 = function () {
  const a = this.bytes_[this.cursor_ + 0];
  const b = this.bytes_[this.cursor_ + 1];
  this.cursor_ += 2;
  assert(this.cursor_ <= this.end_);
  return (a << 0) | (b << 8);
};

/**
 * Reads a raw unsigned 32-bit integer from the binary stream.
 *
 * @return {number} The unsigned 32-bit integer read from the binary stream.
 */
BinaryDecoder.prototype.readUint32 = function () {
  const a = this.bytes_[this.cursor_ + 0];
  const b = this.bytes_[this.cursor_ + 1];
  const c = this.bytes_[this.cursor_ + 2];
  const d = this.bytes_[this.cursor_ + 3];
  this.cursor_ += 4;
  assert(this.cursor_ <= this.end_);
  return ((a << 0) | (b << 8) | (c << 16) | (d << 24)) >>> 0;
};

/**
 * Reads a raw unsigned 64-bit integer from the binary stream. Note that since
 * Javascript represents all numbers as double-precision floats, there will be
 * precision lost if the absolute value of the integer is larger than 2^53.
 *
 * @return {number} The unsigned 64-bit integer read from the binary stream.
 *     Precision will be lost if the integer exceeds 2^53.
 */
BinaryDecoder.prototype.readUint64 = function () {
  const bitsLow = this.readUint32();
  const bitsHigh = this.readUint32();
  return joinUint64(bitsLow, bitsHigh);
};

/**
 * Reads a raw unsigned 64-bit integer from the binary stream. Note that since
 * Javascript represents all numbers as double-precision floats, there will be
 * precision lost if the absolute value of the integer is larger than 2^53.
 *
 * @return {string} The unsigned 64-bit integer read from the binary stream.
 */
BinaryDecoder.prototype.readUint64String = function () {
  const bitsLow = this.readUint32();
  const bitsHigh = this.readUint32();
  return joinUnsignedDecimalString(bitsLow, bitsHigh);
};

/**
 * Reads a raw signed 8-bit integer from the binary stream.
 *
 * @return {number} The signed 8-bit integer read from the binary stream.
 */
BinaryDecoder.prototype.readInt8 = function () {
  const a = this.bytes_[this.cursor_ + 0];
  this.cursor_ += 1;
  assert(this.cursor_ <= this.end_);
  return (a << 24) >> 24;
};

/**
 * Reads a raw signed 16-bit integer from the binary stream.
 *
 * @return {number} The signed 16-bit integer read from the binary stream.
 */
BinaryDecoder.prototype.readInt16 = function () {
  const a = this.bytes_[this.cursor_ + 0];
  const b = this.bytes_[this.cursor_ + 1];
  this.cursor_ += 2;
  assert(this.cursor_ <= this.end_);
  return (((a << 0) | (b << 8)) << 16) >> 16;
};

/**
 * Reads a raw signed 32-bit integer from the binary stream.
 *
 * @return {number} The signed 32-bit integer read from the binary stream.
 */
BinaryDecoder.prototype.readInt32 = function () {
  const a = this.bytes_[this.cursor_ + 0];
  const b = this.bytes_[this.cursor_ + 1];
  const c = this.bytes_[this.cursor_ + 2];
  const d = this.bytes_[this.cursor_ + 3];
  this.cursor_ += 4;
  assert(this.cursor_ <= this.end_);
  return (a << 0) | (b << 8) | (c << 16) | (d << 24);
};

/**
 * Reads a raw signed 64-bit integer from the binary stream. Note that since
 * Javascript represents all numbers as double-precision floats, there will be
 * precision lost if the absolute value of the integer is larger than 2^53.
 *
 * @return {number} The signed 64-bit integer read from the binary stream.
 *     Precision will be lost if the integer exceeds 2^53.
 */
BinaryDecoder.prototype.readInt64 = function () {
  const bitsLow = this.readUint32();
  const bitsHigh = this.readUint32();
  return joinInt64(bitsLow, bitsHigh);
};

/**
 * Reads a raw signed 64-bit integer from the binary stream and returns it as a
 * string.
 *
 * @return {string} The signed 64-bit integer read from the binary stream.
 *     Precision will be lost if the integer exceeds 2^53.
 */
BinaryDecoder.prototype.readInt64String = function () {
  const bitsLow = this.readUint32();
  const bitsHigh = this.readUint32();
  return joinSignedDecimalString(bitsLow, bitsHigh);
};

/**
 * Reads a 32-bit floating-point number from the binary stream, using the
 * temporary buffer to realign the data.
 *
 * @return {number} The float read from the binary stream.
 */
BinaryDecoder.prototype.readFloat = function () {
  const bitsLow = this.readUint32();
  const bitsHigh = 0;
  return joinFloat32(bitsLow, bitsHigh);
};

/**
 * Reads a 64-bit floating-point number from the binary stream, using the
 * temporary buffer to realign the data.
 *
 * @return {number} The double read from the binary stream.
 */
BinaryDecoder.prototype.readDouble = function () {
  const bitsLow = this.readUint32();
  const bitsHigh = this.readUint32();
  return joinFloat64(bitsLow, bitsHigh);
};

/**
 * Reads a boolean value from the binary stream.
 * @return {boolean} The boolean read from the binary stream.
 */
BinaryDecoder.prototype.readBool = function () {
  return !!this.bytes_[this.cursor_++];
};

/**
 * Reads an enum value from the binary stream, which are always encoded as
 * signed varints.
 * @return {number} The enum value read from the binary stream.
 */
BinaryDecoder.prototype.readEnum = function () {
  return this.readSignedVarint32();
};

/**
 * Reads and parses a UTF-8 encoded unicode string from the stream.
 * The code is inspired by maps.vectortown.parse.StreamedDataViewReader.
 * Supports codepoints from U+0000 up to U+10FFFF.
 * (http://en.wikipedia.org/wiki/UTF-8).
 * @param {number} length The length of the string to read.
 * @return {string} The decoded string.
 */
BinaryDecoder.prototype.readString = function (length) {
  const bytes = this.bytes_;
  let cursor = this.cursor_;
  const end = cursor + length;
  const codeUnits = [];

  let result = "";
  while (cursor < end) {
    const c = bytes[cursor++];
    if (c < 128) {
      // Regular 7-bit ASCII.
      codeUnits.push(c);
    } else if (c < 192) {
      // UTF-8 continuation mark. We are out of sync. This
      // might happen if we attempted to read a character
      // with more than four bytes.
      continue;
    } else if (c < 224) {
      // UTF-8 with two bytes.
      var c2 = bytes[cursor++];
      codeUnits.push(((c & 31) << 6) | (c2 & 63));
    } else if (c < 240) {
      // UTF-8 with three bytes.
      var c2 = bytes[cursor++];
      var c3 = bytes[cursor++];
      codeUnits.push(((c & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63));
    } else if (c < 248) {
      // UTF-8 with 4 bytes.
      var c2 = bytes[cursor++];
      var c3 = bytes[cursor++];
      const c4 = bytes[cursor++];
      // Characters written on 4 bytes have 21 bits for a codepoint.
      // We can't fit that on 16bit characters, so we use surrogates.
      let codepoint =
        ((c & 7) << 18) | ((c2 & 63) << 12) | ((c3 & 63) << 6) | (c4 & 63);
      // Surrogates formula from wikipedia.
      // 1. Subtract 0x10000 from codepoint
      codepoint -= 0x10000;
      // 2. Split this into the high 10-bit value and the low 10-bit value
      // 3. Add 0xD800 to the high value to form the high surrogate
      // 4. Add 0xDC00 to the low value to form the low surrogate:
      const low = (codepoint & 1023) + 0xdc00;
      const high = ((codepoint >> 10) & 1023) + 0xd800;
      codeUnits.push(high, low);
    }

    // Avoid exceeding the maximum stack size when calling `apply`.
    if (codeUnits.length >= 8192) {
      result += String.fromCharCode.apply(null, codeUnits);
      codeUnits.length = 0;
    }
  }
  result += byteArrayToString(codeUnits);
  this.cursor_ = cursor;
  return result;
};

/**
 * Reads and parses a UTF-8 encoded unicode string (with length prefix) from
 * the stream.
 * @return {string} The decoded string.
 */
BinaryDecoder.prototype.readStringWithLength = function () {
  const length = this.readUnsignedVarint32();
  return this.readString(length);
};

/**
 * Reads a block of raw bytes from the binary stream.
 *
 * @param {number} length The number of bytes to read.
 * @return {!Uint8Array} The decoded block of bytes, or an empty block if the
 *     length was invalid.
 */
BinaryDecoder.prototype.readBytes = function (length) {
  if (length < 0 || this.cursor_ + length > this.bytes_.length) {
    this.error_ = true;
    fail("Invalid byte length!");
    return new Uint8Array(0);
  }

  const result = this.bytes_.subarray(this.cursor_, this.cursor_ + length);

  this.cursor_ += length;
  assert(this.cursor_ <= this.end_);
  return result;
};

/**
 * Reads a 64-bit varint from the stream and returns it as an 8-character
 * Unicode string for use as a hash table key.
 *
 * @return {string} The hash value.
 */
BinaryDecoder.prototype.readVarintHash64 = function () {
  return this.readSplitVarint64(joinHash64);
};

/**
 * Reads a 64-bit fixed-width value from the stream and returns it as an
 * 8-character Unicode string for use as a hash table key.
 *
 * @return {string} The hash value.
 */
BinaryDecoder.prototype.readFixedHash64 = function () {
  const bytes = this.bytes_;
  const cursor = this.cursor_;

  const a = bytes[cursor + 0];
  const b = bytes[cursor + 1];
  const c = bytes[cursor + 2];
  const d = bytes[cursor + 3];
  const e = bytes[cursor + 4];
  const f = bytes[cursor + 5];
  const g = bytes[cursor + 6];
  const h = bytes[cursor + 7];

  this.cursor_ += 8;

  return String.fromCharCode(a, b, c, d, e, f, g, h);
};
