import type { SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  createAssistantMessageEventStream,
  calculateCost,
  type AssistantMessage,
  type Model,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { parseArguments, validateJsonObject } from "./validation.ts";
import { sdkToolName } from "./mcp.ts";

export function createOutput({ model, tools }: { model: Model<string>; tools: Tool[] }) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    stopReason: "pending",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const indexes = new Map<number, { index: number; json: string; ended: boolean }>();
  const rejected = new Map<string, string>();
  let priorUsage = structuredClone(message.usage);
  let started = false;
  let apiStarted = false;
  let stopped = false;
  let terminal = false;
  let stopReason: "stop" | "length" | "toolUse" = "stop";

  function start() {
    if (started) return;
    started = true;
    stream.push({ type: "start", partial: message });
  }
  function price() {
    const usage = message.usage;
    usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    calculateCost(model, usage);
  }
  function event({ event }: { event: SDKPartialAssistantMessage["event"] }) {
    if (terminal) throw new Error("pi-claude: received SDK content after Pi stream completion");
    start();
    switch (event.type) {
      case "message_start": {
        if (apiStarted && !stopped)
          throw new Error("pi-claude: SDK restarted an unfinished assistant response");
        if (event.message.content.length)
          throw new Error("pi-claude: SDK message_start unexpectedly included completed content");
        // A native turn can contain multiple completed assistant responses before
        // its SDK result (including empty/thinking-only continuations). Keep all
        // blocks and usage; only a fully stopped response may start a successor.
        if (apiStarted) priorUsage = structuredClone(message.usage);
        indexes.clear();
        stopped = false;
        apiStarted = true;
        message.rawStopReason = undefined;
        message.responseId = event.message.id;
        message.responseModel = event.message.model;
        message.usage.input = priorUsage.input + event.message.usage.input_tokens;
        message.usage.output = priorUsage.output + event.message.usage.output_tokens;
        message.usage.cacheRead =
          priorUsage.cacheRead + (event.message.usage.cache_read_input_tokens ?? 0);
        message.usage.cacheWrite =
          priorUsage.cacheWrite + (event.message.usage.cache_creation_input_tokens ?? 0);
        const hour = event.message.usage.cache_creation?.ephemeral_1h_input_tokens;
        if (hour !== undefined || priorUsage.cacheWrite1h !== undefined)
          message.usage.cacheWrite1h = (priorUsage.cacheWrite1h ?? 0) + (hour ?? 0);
        price();
        break;
      }
      case "content_block_start": {
        if (!apiStarted || stopped || indexes.has(event.index))
          throw new Error("pi-claude: invalid SDK block start");
        const block = event.content_block;
        const index = message.content.length;
        indexes.set(event.index, { index, json: "", ended: false });
        switch (block.type) {
          case "text":
            message.content.push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex: index, partial: message });
            if (block.text)
              throw new Error("pi-claude: SDK text block unexpectedly started with content");
            break;
          case "thinking":
            message.content.push({
              type: "thinking",
              thinking: "",
              thinkingSignature: block.signature,
            });
            stream.push({ type: "thinking_start", contentIndex: index, partial: message });
            if (block.thinking)
              throw new Error("pi-claude: SDK thinking block unexpectedly started with content");
            break;
          case "redacted_thinking":
            message.content.push({
              type: "thinking",
              thinking: "",
              thinkingSignature: block.data,
              redacted: true,
            });
            stream.push({ type: "thinking_start", contentIndex: index, partial: message });
            break;
          case "tool_use": {
            if (
              Object.keys(
                validateJsonObject({ value: block.input, source: "SDK tool block start" }),
              ).length
            )
              throw new Error("pi-claude: SDK tool block unexpectedly started with arguments");
            const tool = tools.find((entry) => sdkToolName({ name: entry.name }) === block.name);
            if (!tool) {
              if (rejected.has(block.id)) throw new Error("pi-claude: duplicate rejected tool ID");
              rejected.set(block.id, block.name);
              indexes.set(event.index, { index: -1, json: "", ended: false });
              break;
            }
            message.content.push({
              type: "toolCall",
              id: block.id,
              name: tool.name,
              arguments: {},
            });
            stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
            break;
          }
          default:
            throw new Error(`pi-claude: unsupported SDK content block ${block.type}`);
        }
        break;
      }
      case "content_block_delta": {
        const state = indexes.get(event.index);
        if (!state || state.ended) throw new Error("pi-claude: SDK delta without an open block");
        const delta = event.delta;
        if (state.index === -1) {
          if (delta.type !== "input_json_delta")
            throw new Error("pi-claude: invalid rejected tool delta");
          state.json += delta.partial_json;
          break;
        }
        const block = message.content[state.index];
        if (delta.type === "text_delta" && block.type === "text") {
          block.text += delta.text;
          stream.push({
            type: "text_delta",
            contentIndex: state.index,
            delta: delta.text,
            partial: message,
          });
        } else if (delta.type === "thinking_delta" && block.type === "thinking") {
          block.thinking += delta.thinking;
          stream.push({
            type: "thinking_delta",
            contentIndex: state.index,
            delta: delta.thinking,
            partial: message,
          });
        } else if (delta.type === "signature_delta" && block.type === "thinking") {
          block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
        } else if (delta.type === "input_json_delta" && block.type === "toolCall") {
          state.json += delta.partial_json;
          stream.push({
            type: "toolcall_delta",
            contentIndex: state.index,
            delta: delta.partial_json,
            partial: message,
          });
        } else throw new Error(`pi-claude: unsupported or mismatched SDK delta ${delta.type}`);
        break;
      }
      case "content_block_stop": {
        const state = indexes.get(event.index);
        if (!state || state.ended)
          throw new Error("pi-claude: SDK stopped an unknown or completed block");
        state.ended = true;
        if (state.index === -1) {
          parseArguments({ text: state.json || "{}" });
          break;
        }
        const block = message.content[state.index];
        if (block.type === "text")
          stream.push({
            type: "text_end",
            contentIndex: state.index,
            content: block.text,
            partial: message,
          });
        else if (block.type === "thinking")
          stream.push({
            type: "thinking_end",
            contentIndex: state.index,
            content: block.thinking,
            partial: message,
          });
        else {
          block.arguments = parseArguments({ text: state.json || "{}" });
          stream.push({
            type: "toolcall_end",
            contentIndex: state.index,
            toolCall: block,
            partial: message,
          });
        }
        break;
      }
      case "message_delta": {
        message.usage.output = priorUsage.output + event.usage.output_tokens;
        if (event.usage.input_tokens !== undefined && event.usage.input_tokens !== null)
          message.usage.input = priorUsage.input + event.usage.input_tokens;
        if (
          event.usage.cache_read_input_tokens !== undefined &&
          event.usage.cache_read_input_tokens !== null
        )
          message.usage.cacheRead = priorUsage.cacheRead + event.usage.cache_read_input_tokens;
        if (
          event.usage.cache_creation_input_tokens !== undefined &&
          event.usage.cache_creation_input_tokens !== null
        )
          message.usage.cacheWrite =
            priorUsage.cacheWrite + event.usage.cache_creation_input_tokens;
        price();
        const reason = event.delta.stop_reason;
        if (reason === "tool_use") stopReason = "toolUse";
        else if (reason === "max_tokens" || reason === "model_context_window_exceeded")
          stopReason = "length";
        else if (
          reason === "end_turn" ||
          reason === "stop_sequence" ||
          reason === "refusal" ||
          reason === null
        )
          stopReason = "stop";
        else throw new Error(`pi-claude: unexpected SDK stop reason ${reason}`);
        message.rawStopReason = reason ?? undefined;
        break;
      }
      case "message_stop":
        if (!apiStarted || stopped || [...indexes.values()].some((block) => !block.ended))
          throw new Error("pi-claude: incomplete SDK assistant response");
        stopped = true;
        break;
      default:
        throw new Error("pi-claude: unsupported SDK stream event");
    }
  }
  return {
    stream,
    message,
    rejected,
    event,
    get terminal() {
      return terminal;
    },
    get stopped() {
      return stopped;
    },
    get reason() {
      return stopReason;
    },
    batch(): ToolCall[] {
      return message.content.filter((block): block is ToolCall => block.type === "toolCall");
    },
    finish({ reason }: { reason: "stop" | "length" | "toolUse" }) {
      if (terminal) throw new Error("pi-claude: duplicate terminal stream event");
      start();
      if (!stopped) throw new Error("pi-claude: SDK result preceded assistant message completion");
      terminal = true;
      price();
      message.stopReason = reason;
      stream.push({ type: "done", reason, message });
      stream.end();
    },
    fail({ error, aborted = false }: { error: Error; aborted?: boolean }) {
      if (terminal) return;
      terminal = true;
      message.stopReason = aborted ? "aborted" : "error";
      message.errorMessage = error.message;
      stream.push({ type: "error", reason: message.stopReason, error: message });
      stream.end();
    },
  };
}
export type Output = ReturnType<typeof createOutput>;
