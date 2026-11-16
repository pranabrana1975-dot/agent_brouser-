// tools.d.ts — TypeScript declarations for AgentBrowser v2.0 shared tool catalogue.

export type ExtractFormat =
  | 'text'
  | 'html'
  | 'markdown'
  | 'links'
  | 'forms'
  | 'tables'
  | 'metadata'
  | 'items'
  | 'schema';

export type AgentBrowserToolName =
  | 'browser_open'
  | 'browser_snapshot'
  | 'browser_click'
  | 'browser_drag'
  | 'browser_type'
  | 'browser_select'
  | 'browser_press'
  | 'browser_clipboard'
  | 'browser_hover'
  | 'browser_scroll'
  | 'browser_wait'
  | 'browser_wait_for'
  | 'browser_batch'
  | 'browser_workflow'
  | 'browser_extract'
  | 'browser_read'
  | 'browser_screenshot'
  | 'browser_pdf'
  | 'browser_downloads'
  | 'browser_visual_diff'
  | 'browser_upload'
  | 'browser_navigate'
  | 'browser_tabs'
  | 'browser_task'
  | 'browser_network'
  | 'browser_console'
  | 'browser_evaluate'
  | 'browser_inspect'
  | 'browser_a11y'
  | 'browser_diff'
  | 'browser_perf'
  | 'browser_audit'
  | 'browser_storage'
  | 'browser_security'
  | 'browser_emulate'
  | 'browser_dialog'
  | 'browser_trace';

export interface JsonSchemaProperty {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
  additionalProperties?: boolean;
  oneOf?: readonly JsonSchemaProperty[];
}

export interface ToolDefinition {
  name: AgentBrowserToolName;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, JsonSchemaProperty>;
    required?: readonly string[];
    additionalProperties?: boolean;
  };
}

export declare const tools: readonly ToolDefinition[];
