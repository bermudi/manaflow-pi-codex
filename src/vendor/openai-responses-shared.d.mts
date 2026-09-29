// Types for the vendored pi-ai Responses converter. The runtime module
// (openai-responses-shared.mjs) is a generated snapshot — see
// scripts/vendor-pi-ai.mjs — while these declarations stay attached to the
// declared @earendil-works/pi-ai peer range, so a drift fails the parity test
// and the typecheck together.
export {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "@earendil-works/pi-ai/api/openai-responses-shared";
