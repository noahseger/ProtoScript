import PluginPb from "google-protobuf/google/protobuf/compiler/plugin_pb.js";
import type { CodeGeneratorResponse as CodeGeneratorResponseType } from "google-protobuf/google/protobuf/compiler/plugin_pb.js";
import { generate } from "./autogenerate/index.js";
import {
  getProtobufTSFileName,
  buildIdentifierTable,
  getProtobufJSFileName,
  KNOWN_TYPES,
} from "./utils.js";
import { format } from "prettier";
import { deserializeConfig } from "../cli/utils.js";
const { CodeGeneratorRequest, CodeGeneratorResponse } = PluginPb;
import { type Plugin } from "../plugin.js";

export function compile(
  input: Uint8Array,
  plugins: Plugin[] = []
): CodeGeneratorResponseType {
  const request = CodeGeneratorRequest.deserializeBinary(input);
  const options = deserializeConfig(request.getParameter() ?? "");
  const isTypescript = options.language === "typescript";
  const response = new CodeGeneratorResponse();
  response.setSupportedFeatures(
    CodeGeneratorResponse.Feature.FEATURE_PROTO3_OPTIONAL
  );

  const identifierTable = buildIdentifierTable(request);

  function writeFile(name: string, content: string) {
    const file = new CodeGeneratorResponse.File();
    file.setName(name);
    file.setContent(
      format(content, { parser: isTypescript ? "typescript" : "babel" })
    );
    response.addFile(file);
  }

  request.getProtoFileList().forEach((fileDescriptorProto) => {
    const name = fileDescriptorProto.getName();
    if (!name) {
      return;
    }
    if (!process.env.GENERATE_KNOWN_TYPES && KNOWN_TYPES.includes(name)) {
      return;
    }

    const protobufTs = generate(
      fileDescriptorProto,
      identifierTable,
      options,
      plugins
    );
    writeFile(
      isTypescript ? getProtobufTSFileName(name) : getProtobufJSFileName(name),
      protobufTs
    );
  });

  return response;
}

function readStream(stream: NodeJS.ReadStream): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("readable", () => {
      let chunk: Buffer;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      while ((chunk = process.stdin.read()) !== null) {
        chunks.push(chunk);
      }
    });
    stream.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
  });
}

export async function compiler(protocompile: typeof compile): Promise<void> {
  const input = await readStream(process.stdin);
  const response = protocompile(input);
  process.stdout.write(response.serializeBinary());
}
