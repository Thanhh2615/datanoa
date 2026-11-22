export { EditorState, EditorSelection, Compartment, type Extension } from '@codemirror/state';
export { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
export { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
export { HighlightStyle, syntaxHighlighting, LanguageSupport, StreamLanguage, foldGutter, codeFolding, foldKeymap, bracketMatching } from '@codemirror/language';
export { autocompletion, completionKeymap } from '@codemirror/autocomplete';
export { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
export { sql, SQLite, PostgreSQL, MySQL, MariaSQL, schemaCompletionSource, type SQLDialect } from '@codemirror/lang-sql';
export { tags } from '@lezer/highlight';
