import type { AppIconComponent } from "@/components/icons"
import {
  BrowserSearchIcon,
  CreateNoteIcon,
  EditNoteIcon,
  FolderIcon,
  FolderPlusActionIcon,
  ImageGenerationIcon,
  ImageSearchWidgetIcon,
  DocumentFileIcon,
  LinkIcon,
  MemorySearchIcon,
  NoteIcon,
  OutlineGeneratorIcon,
  ReadNoteIcon,
  ScrollIcon,
  StockWidgetIcon,
  ToolCodeIcon,
  TreeMapIcon,
  WeatherWidgetIcon,
  WebCollectorIcon,
  WriteNoteToolIcon,
} from "@/components/icons"
import type { Annotation, ToolOutput } from "./tool-outputs"


/**
 * Represents the type of streaming message in the agent response.
 */
export type StreamingMessageType = "stream_message" | "stream_reasoning_message"


/**
 * Represents the type of streaming message content in the agent response.
 */
export type StreamingContentType = "token" | "status" | "message"


/**
 * Represents the execution state of a tool in the agent streaming response.
 */
export type ToolExecutionState = "started" | "completed" | "failed"


/**
 * Represents a message in the agent streaming response.
 */
export interface AgentStreamMessage {
  type: StreamingMessageType
  toolId: string
  toolName: ToolName
  content?: {
    type: StreamingContentType
    text: string
    annotations: Annotation[]
  }
  isStop: boolean | "error"
}


/**
 * Represents a persisted reasoning text step.
 */
export interface ReasoningTextStep {
  type: "reasoning_step"
  id: string
  reasoning: string
  message: string
  isSynthesis?: boolean
}


/**
 * Represents a structured tool call step.
 */
export interface ToolCallStep {
  type: "tool_call"
  id: string
  name: ToolName
  thought: string
  output: ToolOutput
  state: ToolExecutionState
  eventMessages: string[]
  arguments?: { input: unknown }
}


/**
 * Represents one ordered item in the assistant process.
 */
export type ReasoningStep = ReasoningTextStep | ToolCallStep


/**
 * AgentResponse represents the response from the agent, containing reasoning steps.
 */
export interface AgentResponse {
  steps: ReasoningStep[]
  sentAt?: string
  isDeepResearch?: boolean
}


/**
 * Agent tool names enum.
 */
export type ToolName =
  | "answer_reformulate"
  | "web_search"
  | "memory_search"
  | "code_interpreter"
  | "write_note"
  | "create_note"
  | "edit_note"
  | "get_note"
  | "link_notes"
  | "arrange_notes"
  | "navigate"
  | "create_folder"
  | "outline_generator"
  | "web_collector"
  | "synthesizer"
  | "fetch"
  | "doc_search"
  | "raw_message"
  | "image_description"
  | "topic_illustrator"
  | "image_generation"
  | "display_weather_widget"
  | "display_stock_widget"
  | "display_image_search_widget"
  | "learn_generate_html_widget"
  | "learn_generate_mini_app"
  | "learn_generate_diagram"


export const ToolNameDescription: Record<ToolName, string> = {
  answer_reformulate: "Reformulate answer",
  web_search: "Search the web",
  memory_search: "Search memory",
  code_interpreter: "Interpret code",
  write_note: "Write note",
  create_note: "Create note",
  edit_note: "Edit note",
  get_note: "Read note",
  link_notes: "Link notes",
  arrange_notes: "Arrange notes",
  navigate: "Open folder",
  create_folder: "Create folder",
  outline_generator: "Generate outline",
  web_collector: "Collect web content",
  synthesizer: "Synthesize response",
  fetch: "Fetch and analyze web page content",
  doc_search: "Search uploaded documents",
  raw_message: "Reasoning",
  image_description: "Describe image",
  topic_illustrator: "Illustrate topic",
  image_generation: "Generate images based on prompts",
  display_weather_widget: "Display weather information",
  display_stock_widget: "Display stock information",
  display_image_search_widget: "Search for images from the web",
  learn_generate_html_widget: "Learn widget and visual explainer skill",
  learn_generate_mini_app: "Learn interactive React mini-app skill",
  learn_generate_diagram: "Learn mindmap and diagram skill",
}


// Keyed by the full ToolName union so the compiler flags any missing icon —
// a missing entry rendered `undefined` (React "Element type is invalid").
export const ToolNameIcon: Record<ToolName, AppIconComponent> = {
  raw_message: NoteIcon,
  answer_reformulate: NoteIcon,
  web_search: BrowserSearchIcon,
  memory_search: MemorySearchIcon,
  doc_search: DocumentFileIcon,
  outline_generator: OutlineGeneratorIcon,
  web_collector: WebCollectorIcon,
  synthesizer: NoteIcon,
  fetch: BrowserSearchIcon,
  code_interpreter: ToolCodeIcon,
  write_note: WriteNoteToolIcon,
  create_note: CreateNoteIcon,
  edit_note: EditNoteIcon,
  get_note: ReadNoteIcon,
  link_notes: LinkIcon,
  arrange_notes: TreeMapIcon,
  navigate: FolderIcon,
  create_folder: FolderPlusActionIcon,
  image_description: ImageGenerationIcon,
  topic_illustrator: ImageGenerationIcon,
  image_generation: ImageGenerationIcon,
  display_weather_widget: WeatherWidgetIcon,
  display_stock_widget: StockWidgetIcon,
  display_image_search_widget: ImageSearchWidgetIcon,
  learn_generate_html_widget: ScrollIcon,
  learn_generate_mini_app: ScrollIcon,
  learn_generate_diagram: ScrollIcon,
}


/** Fallback icon for a tool name not in `ToolNameIcon` — keeps a missing entry
 *  from rendering `undefined` (React "Element type is invalid" crash). */
export const DEFAULT_TOOL_ICON: AppIconComponent = NoteIcon


export const RAW_MESSAGE: ToolName = "raw_message"


/** Legacy tool-name aliases → canonical `ToolName`. The retiring backend runtime
 *  (and persisted history) emits `"navigate"` for what is now `"fetch"`; map it
 *  on ingestion so old messages and the live legacy stream still render. */
const TOOL_NAME_ALIASES: Record<string, ToolName> = {
  navigate: "fetch",
}


/** Resolve a raw wire/persisted tool name to its canonical `ToolName`. */
export const canonicalToolName = (name: string): ToolName =>
  TOOL_NAME_ALIASES[name] ?? (name as ToolName)


/**
 * Checks whether a tool name should be rendered as reasoning/message text.
 */
export const isReasoningTextToolName = (toolName: ToolName) =>
  toolName === "raw_message" ||
  toolName === "answer_reformulate" ||
  toolName === "synthesizer"


/**
 * Normalizes text-like tool steps into reasoning text steps for rendering.
 */
export const normalizeReasoningStep = (step: ReasoningStep): ReasoningStep => {
  if (step.type !== "tool_call") return step
  // Canonicalize legacy/persisted names (e.g. "navigate" → "fetch") so old
  // messages resolve a real icon/title.
  const name = canonicalToolName(step.name)
  if (!isReasoningTextToolName(name)) {
    return name === step.name ? step : { ...step, name }
  }

  return {
    type: "reasoning_step",
    id: step.id,
    reasoning: step.thought || "",
    message: typeof step.output === "string" ? step.output : "",
    isSynthesis: name === "synthesizer",
  }
}


/**
 * Normalizes a mixed step list so text-like tool steps render as reasoning text.
 */
export const normalizeReasoningSteps = (steps: ReasoningStep[]) =>
  steps.map(normalizeReasoningStep)


/**
 * Checks whether a reasoning step is a text step.
 */
export const isReasoningTextStep = (step: ReasoningStep): step is ReasoningTextStep =>
  step.type === "reasoning_step"


/**
 * Checks whether a reasoning step is a tool call step.
 */
export const isToolCallStep = (step: ReasoningStep): step is ToolCallStep =>
  step.type === "tool_call"
