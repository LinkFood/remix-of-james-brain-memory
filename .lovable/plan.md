

# Wire Up Code Workspace Components

## Problem

The `CodeWorkspace.tsx` page uses inline implementations for chat, file browser, code viewer, and terminal instead of the dedicated components from the commit (`CodeChat`, `FileBrowser`, `CodeViewer`, `AgentTerminal`, `SessionHistory`). This means:

- **Chat doesn't work** -- the inline `<input>` is a basic HTML input, not the `CodeChat` component with Textarea, Enter-to-send, and example command chips
- **File browser** is a flat list instead of the proper tree view with collapsible folders
- **Code viewer** is a plain `<pre>` instead of the component with line numbers and file header
- **Terminal** is basic text instead of the styled component with status icons and auto-scroll
- **Session history** is not shown anywhere

## Changes

**Single file edit: `src/pages/CodeWorkspace.tsx`**

1. Import the 5 missing components:
   - `CodeChat` from `@/components/code/CodeChat`
   - `FileBrowser` from `@/components/code/FileBrowser`
   - `CodeViewer` from `@/components/code/CodeViewer`
   - `AgentTerminal` from `@/components/code/AgentTerminal`
   - `SessionHistory` from `@/components/code/SessionHistory`

2. **Desktop layout** (lines 92-226): Replace inline implementations with components:
   - Replace inline file list (lines 107-136) with `<FileBrowser files={fileTree} selectedFile={selectedFile} onSelectFile={loadFileContent} loading={fileLoading} />`
   - Replace inline code `<pre>` (lines 138-152) with `<CodeViewer content={selectedFileContent} filePath={selectedFile} loading={fileLoading} />`
   - Replace inline terminal logs (lines 171-192) with `<AgentTerminal logs={terminalLogs} sessionStatus={activeSession?.status ?? null} />`
   - Replace inline chat form (lines 194-224) with `<CodeChat onSend={sendCodeCommand} sending={sending} projectName={activeProject?.name ?? null} />`
   - Add a Sessions tab alongside Terminal and Chat

3. **Mobile layout** (lines 230-343): Same replacements:
   - Replace inline file list with `<FileBrowser>`
   - Replace inline code viewer with `<CodeViewer>`
   - Replace inline terminal with `<AgentTerminal>`
   - Replace inline chat with `<CodeChat>`

## Technical Details

### Component prop mapping

```text
CodeChat
  onSend       -> sendCodeCommand
  sending      -> sending
  projectName  -> activeProject?.name ?? null

FileBrowser
  files        -> fileTree (string[] from useCodeWorkspace)
  selectedFile -> selectedFile
  onSelectFile -> loadFileContent
  loading      -> fileLoading

CodeViewer
  content      -> selectedFileContent
  filePath     -> selectedFile
  loading      -> fileLoading

AgentTerminal
  logs          -> terminalLogs
  sessionStatus -> activeSession?.status ?? null

SessionHistory
  sessions     -> sessions
```

### Desktop layout structure (revised)

```text
+------------------+-------------------+---------------------+
| ProjectList      | FileBrowser       | Tabs: Terminal |    |
| (w-56)           | (top half)        |       Chat     |    |
|                  +---------+---------+       Sessions  |    |
|                  | CodeViewer        |                      |
|                  | (bottom half)     | AgentTerminal /      |
|                  |                   | CodeChat /           |
|                  |                   | SessionHistory       |
+------------------+-------------------+---------------------+
```

### Mobile layout (revised)

Same 4 tabs but using proper components: Projects | Files | Terminal | Chat. The Files tab shows FileBrowser at top and CodeViewer below when a file is selected.

