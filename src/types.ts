// ─── OpenCode TUI command identifiers (from tui.json keybinds) ───

export type TuiCommandId =
  // App
  | "app_exit"
  | "app_debug"
  | "app_console"
  | "app_heap_snapshot"
  | "app_toggle_animations"
  | "app_toggle_file_context"
  | "app_toggle_diffwrap"
  | "app_toggle_paste_summary"
  | "app_toggle_session_directory_filter"
  // Sessions
  | "session_new"
  | "session_list"
  | "session_timeline"
  | "session_fork"
  | "session_rename"
  | "session_delete"
  | "session_share"
  | "session_unshare"
  | "session_interrupt"
  | "session_compact"
  | "session_toggle_timestamps"
  | "session_toggle_generic_tool_output"
  | "session_export"
  | "session_copy"
  | "session_move"
  | "session_child_first"
  | "session_child_cycle"
  | "session_child_cycle_reverse"
  | "session_parent"
  // Editor / prompt
  | "editor_open"
  | "command_list"
  | "input_clear"
  | "input_paste"
  | "input_submit"
  | "input_newline"
  | "input_move_left"
  | "input_move_right"
  | "input_move_up"
  | "input_move_down"
  | "input_select_left"
  | "input_select_right"
  | "input_select_up"
  | "input_select_down"
  | "input_line_home"
  | "input_line_end"
  | "input_select_line_home"
  | "input_select_line_end"
  | "input_visual_line_home"
  | "input_visual_line_end"
  | "input_select_visual_line_home"
  | "input_select_visual_line_end"
  | "input_buffer_home"
  | "input_buffer_end"
  | "input_select_buffer_home"
  | "input_select_buffer_end"
  | "input_delete_line"
  | "input_delete_to_line_end"
  | "input_delete_to_line_start"
  | "input_backspace"
  | "input_delete"
  | "input_undo"
  | "input_redo"
  | "input_word_forward"
  | "input_word_backward"
  | "input_select_word_forward"
  | "input_select_word_backward"
  | "input_delete_word_forward"
  | "input_delete_word_backward"
  | "input_select_all"
  | "history_previous"
  | "history_next"
  // Dialogs
  | "dialog.select.prev"
  | "dialog.select.next"
  | "dialog.select.page_up"
  | "dialog.select.page_down"
  | "dialog.select.home"
  | "dialog.select.end"
  | "dialog.select.submit"
  | "dialog.prompt.submit"
  | "dialog.mcp.toggle"
  | "dialog.plugins.install"
  // Navigation
  | "sidebar_toggle"
  | "scrollbar_toggle"
  | "status_view"
  | "theme_list"
  | "theme_switch_mode"
  | "theme_mode_lock"
  | "model_provider_list"
  | "model_favorite_toggle"
  | "model_list"
  | "model_cycle_recent"
  | "model_cycle_recent_reverse"
  | "model_cycle_favorite"
  | "model_cycle_favorite_reverse"
  | "mcp_list"
  | "provider_connect"
  | "agent_list"
  | "agent_cycle"
  | "agent_cycle_reverse"
  | "variant_cycle"
  | "variant_list"
  // Messages
  | "messages_page_up"
  | "messages_page_down"
  | "messages_line_up"
  | "messages_line_down"
  | "messages_half_page_up"
  | "messages_half_page_down"
  | "messages_first"
  | "messages_last"
  | "messages_next"
  | "messages_previous"
  | "messages_last_user"
  | "messages_copy"
  | "messages_undo"
  | "messages_redo"
  | "messages_toggle_conceal"
  | "tool_details"
  | "display_thinking"
  // Prompt
  | "prompt_submit"
  | "prompt_editor_context_clear"
  | "prompt_skills"
  | "prompt_stash"
  | "prompt_stash_pop"
  | "prompt_stash_list"
  | "workspace_set"
  | "stash_delete"
  // Autocomplete
  | "prompt.autocomplete.prev"
  | "prompt.autocomplete.next"
  | "prompt.autocomplete.hide"
  | "prompt.autocomplete.select"
  | "prompt.autocomplete.complete"
  // Permissions
  | "permission.prompt.fullscreen"
  | "plugins.toggle"
  // Terminal
  | "terminal_suspend"
  | "terminal_title_toggle"
  // Help / Docs
  | "help_show"
  | "docs_open"
  | "tips_toggle"
  | "which_key_toggle"
  | "which_key_layout_toggle"
  | "which_key_pending_toggle"
  | "which_key_group_previous"
  | "which_key_group_next"
  | "which_key_scroll_up"
  | "which_key_scroll_down"
  | "which_key_page_up"
  | "which_key_page_down"
  | "which_key_home"
  | "which_key_end"
  | "plugin_manager"
  | "plugin_install"
  | "console_org_switch";

// ─── Server status ───

export interface ServerStatus {
  healthy: boolean;
  version: string;
}

export interface SessionInfo {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  path: string;
  parentID?: string;
  title: string;
  agent?: string;
  model?: {
    id: string;
    providerID: string;
    variant?: string;
  };
  summary: {
    additions: number;
    deletions: number;
    files: number;
  };
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  version: string;
  time: { created: number; updated: number };
}

// ─── Webview messages ───

export type WebviewToExtension =
  | { type: "keyboard"; key: string; ctrl: boolean; alt: boolean; meta: boolean; shift: boolean }
  | { type: "textInput"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ready" };

export type ExtensionToWebview =
  | { type: "terminalData"; data: string }
  | { type: "setLeaderActive"; active: boolean }
  | { type: "serverStatus"; status: ServerStatus };

// ─── Command context (extensible payload for future integrations) ───

export interface CommandContext {
  /** File path from explorer/editor context menu */
  filePath?: string;
  /** Arbitrary params for extensibility */
  params?: Record<string, unknown>;
}

// ─── Dispatched command (internal) ───

export interface DispatchedCommand {
  /** OpenCode TUI command ID */
  tuiCommand?: TuiCommandId;
  /** Or a custom action handler name */
  customAction?: string;
  /** Context (file, etc.) */
  context?: CommandContext;
}

// ─── Key mapping ───

export interface KeyMapping {
  /** Physical key code (event.code) */
  code: string;
  /** Requires Ctrl modifier */
  ctrl?: boolean;
  /** Requires Alt modifier */
  alt?: boolean;
  /** Shift modifier */
  shift?: boolean;
  /** Mapped command */
  command: DispatchedCommand;
}
