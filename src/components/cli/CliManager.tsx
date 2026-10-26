import { notify } from "../../lib/notify";
import { parseCliArguments } from "../../lib/cliArgs";
import React, { useEffect, useState } from "react";
import {
  Check,
  Copy,
  Play,
  Plus,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  Label,
  ListBox,
  Select,
  Spinner,
  Switch,
} from "@heroui/react";
import { CliToolInfo, CommandOutput } from "../../types";
import { ToolRowSkeleton } from "../ui/Skeleton";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { Modal } from "../ui/Modal";
import { Field, TextInput } from "../ui/Field";
import { EmptyState } from "../ui/EmptyState";
import { Segmented } from "../ui/Segmented";

interface CliManagerProps {
  tools: CliToolInfo[];
  isLoading: boolean;
  onRefresh: () => void;
  onToggleTool: (id: string) => void;
  onRemoveTool: (id: string) => void;
  onAddCustomTool: (name: string, pathOrCmd: string) => Promise<void>;
  onRunCommand: (command: string, args: string[]) => Promise<CommandOutput>;
}

const ARG_PRESETS = ["--version", "--help", "-v", "status"];

export const CliManager: React.FC<CliManagerProps> = ({
  tools,
  isLoading,
  onRefresh,
  onToggleTool,
  onRemoveTool,
  onAddCustomTool,
  onRunCommand,
}) => {
  const [activeFilter, setActiveFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [customName, setCustomName] = useState("");
  const [customPath, setCustomPath] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  // Terminal Runner state
  const [selectedTool, setSelectedTool] = useState<string>("claude");
  const [cmdArgs, setCmdArgs] = useState<string>("--version");
  const [isRunning, setIsRunning] = useState(false);
  const [cmdResult, setCmdResult] = useState<CommandOutput | null>(null);
  const [copiedOutput, setCopiedOutput] = useState(false);
  const selectedToolEnabled = tools.some((tool) => tool.command === selectedTool && tool.is_available && tool.is_enabled);
  useEffect(() => {
    if (!selectedToolEnabled) setSelectedTool(tools.find((tool) => tool.is_available && tool.is_enabled)?.command ?? "");
  }, [tools, selectedToolEnabled]);

  const handleAddCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customName || !customPath) return;
    setIsAdding(true);
    try {
      await onAddCustomTool(customName, customPath);
      setCustomName("");
      setCustomPath("");
      setShowAddModal(false);
    } finally {
      setIsAdding(false);
    }
  };

  const handleExecute = async () => {
    if (!selectedToolEnabled) return;
    setIsRunning(true);
    try {
      const argsArray = parseCliArguments(cmdArgs);
      const res = await onRunCommand(selectedTool, argsArray);
      setCmdResult(res);
      notify(res.success ? "Command completed" : "Command failed", res.success ? "Output is available in the console." : res.stderr || `Exited with code ${res.code}`, res.success ? "success" : "error");
    } catch (err: unknown) {
      notify("Command failed", err instanceof Error ? err.message : "Execution failed", "error");
      setCmdResult({
        success: false,
        code: -1,
        stdout: "",
        stderr: err instanceof Error ? err.message : "Execution failed",
        fallback_used: false,
      });
    } finally {
      setIsRunning(false);
    }
  };

  const handleSelectToolForRun = (command: string) => {
    setSelectedTool(command);
    setCmdArgs("--version");
    // Scroll smoothly to terminal runner
    const terminalEl = document.getElementById("cli-runner-console");
    if (terminalEl) {
      terminalEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  const handleCopyOutput = () => {
    const text = (cmdResult?.stdout || "") + (cmdResult?.stderr || "");
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedOutput(true);
    setTimeout(() => setCopiedOutput(false), 2000);
  };

  const runnableTools = tools.filter((t) => t.is_available && t.is_enabled);

  const matchesSearch = (t: CliToolInfo) => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return (
      t.name.toLowerCase().includes(query) ||
      t.command.toLowerCase().includes(query) ||
      (t.description && t.description.toLowerCase().includes(query))
    );
  };

  const matchesFilter = (t: CliToolInfo) =>
    activeFilter === "all" ||
    (activeFilter === "agent" && t.category === "agent") ||
    (activeFilter === "media" && t.category === "media") ||
    (activeFilter === "runtime" &&
      (t.category === "runtime" || t.category === "animation")) ||
    (activeFilter === "custom" && t.category === "custom");

  const filteredTools = tools.filter((t) => matchesFilter(t) && matchesSearch(t));

  const filterTabs = [
    { value: "all", label: "All", count: tools.length },
    {
      value: "agent",
      label: "Agents",
      count: tools.filter((t) => t.category === "agent").length,
    },
    {
      value: "media",
      label: "Media",
      count: tools.filter((t) => t.category === "media").length,
    },
    {
      value: "runtime",
      label: "Runtimes",
      count: tools.filter(
        (t) => t.category === "runtime" || t.category === "animation",
      ).length,
    },
    {
      value: "custom",
      label: "Custom",
      count: tools.filter((t) => t.category === "custom").length,
    },
  ];

  // Category sections shown when the "All" tab is active.
  const toolGroups = [
    {
      id: "agent",
      label: "Agents",
      tools: tools.filter(
        (t) => t.category === "agent" && matchesSearch(t),
      ),
    },
    {
      id: "media",
      label: "Media",
      tools: tools.filter(
        (t) => t.category === "media" && matchesSearch(t),
      ),
    },
    {
      id: "runtime",
      label: "Runtimes",
      tools: tools.filter(
        (t) =>
          (t.category === "runtime" || t.category === "animation") &&
          matchesSearch(t),
      ),
    },
    {
      id: "custom",
      label: "Custom",
      tools: tools.filter(
        (t) => t.category === "custom" && matchesSearch(t),
      ),
    },
  ].filter((g) => g.tools.length > 0);

  const renderToolRow = (tool: CliToolInfo) => {
    const isActive = tool.is_available && tool.is_enabled;
    return (
      <div
        key={tool.id}
        className={`group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-secondary ${
          tool.is_available ? "" : "opacity-55"
        }`}
      >
        <span
          title={
            tool.is_available
              ? tool.is_enabled
                ? "Active"
                : "Disabled"
              : "Not in PATH"
          }
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${
            isActive ? "bg-success" : "bg-border-tertiary"
          }`}
        />
        <div className="min-w-0 flex-1 leading-snug">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {tool.name}
            </span>
            <code className="shrink-0 font-mono text-xs text-muted">
              {tool.command}
            </code>
          </div>
          <p className="truncate text-xs text-muted">
            {tool.description || tool.path || "No description"}
          </p>
        </div>
        <span className="tabular-nums hidden w-40 shrink-0 truncate text-right font-mono text-xs text-muted md:block">
          {tool.is_available ? tool.version || "Installed" : "Not in PATH"}
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          {tool.category === "custom" && (
            <Button
              variant="ghost"
              iconOnly
              icon={<Trash2 />}
              onClick={() => onRemoveTool(tool.id)}
              aria-label={`Remove ${tool.name}`}
              title="Remove tool"
            />
          )}
          {tool.is_available ? (
            <>
              <Button
                variant="ghost"
                iconOnly
                icon={<Play />}
                onClick={() => handleSelectToolForRun(tool.command)}
                aria-label={`Test ${tool.name} in console`}
                disabled={!tool.is_enabled}
                title="Run test command"
              />
              <Switch
                size="sm"
                isSelected={tool.is_enabled}
                onChange={() => onToggleTool(tool.id)}
                aria-label={`${tool.is_enabled ? "Exclude" : "Include"} ${tool.name} ${tool.is_enabled ? "from" : "in"} console`}
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </Switch>
            </>
          ) : (
            <span className="px-2 text-xs text-muted">Not found</span>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center">
          <Segmented
            label="Filter tools by category"
            value={activeFilter}
            onChange={setActiveFilter}
            options={filterTabs.map((tab) => ({
              value: tab.value,
              label: (
                <>
                  {tab.label}
                  <span className="tabular-nums text-xs text-muted">{tab.count}</span>
                </>
              ),
            }))}
          />
        </div>
        {/* Search + actions stay together so a wrap moves them as one row. */}
        <div className="flex min-w-0 items-center gap-2">
          <label className="relative block w-52 min-w-0">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted" />
            <TextInput
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search tools"
              aria-label="Search tools"
              className="pl-8"
            />
          </label>
          <Button
            variant="secondary"
            isLoading={isLoading}
            icon={<RefreshCw />}
            onClick={onRefresh}
          >
            Rescan
          </Button>
          <Button
            variant="primary"
            icon={<Plus />}
            onClick={() => setShowAddModal(true)}
          >
            Add tool
          </Button>
        </div>
      </div>

      {/* Tool register */}
      {isLoading ? (
        <div className="divide-y divide-separator overflow-hidden rounded-3xl bg-surface shadow-surface">
          <ToolRowSkeleton />
          <ToolRowSkeleton />
          <ToolRowSkeleton />
          <ToolRowSkeleton />
          <ToolRowSkeleton />
        </div>
      ) : filteredTools.length === 0 ? (
        <div className="overflow-hidden rounded-3xl bg-surface shadow-surface">
          <EmptyState
            icon={<Terminal className="size-5" />}
            title="No tools found"
            description="No binaries match the current filter or search."
          />
        </div>
      ) : activeFilter === "all" ? (
        <div className="overflow-hidden rounded-3xl bg-surface shadow-surface">
          {toolGroups.map((group, gi) => (
            <div
              key={group.id}
              className={gi > 0 ? "border-t border-separator" : undefined}
            >
              <div className="flex h-8 items-center gap-2 border-b border-separator bg-surface-secondary/60 px-4">
                <span className="text-xs font-medium tracking-wide text-muted uppercase">
                  {group.label}
                </span>
                <span className="tabular-nums text-xs text-muted">
                  {group.tools.length}
                </span>
              </div>
              <div className="divide-y divide-separator">
                {group.tools.map(renderToolRow)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="divide-y divide-separator overflow-hidden rounded-3xl bg-surface shadow-surface">
          {filteredTools.map(renderToolRow)}
        </div>
      )}

      {/* Console */}
      <div id="cli-runner-console" className="scroll-mt-4 pt-3">
        <div className="overflow-hidden rounded-3xl bg-surface shadow-surface">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-separator px-4 py-2.5">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Console
              </h3>
              <p className="text-xs text-muted">
                Run any enabled tool with arguments
              </p>
            </div>
            <div className="hidden items-center gap-0.5 sm:flex" aria-label="Argument presets">
              {ARG_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  variant={cmdArgs === preset ? "tertiary" : "ghost"}
                  size="sm"
                  onClick={() => setCmdArgs(preset)}
                  className="font-mono"
                >
                  {preset}
                </Button>
              ))}
            </div>
          </div>
          <div className="cli-command-form grid grid-cols-1 items-end gap-3 p-4">
            <div className="min-w-0">
              <Label className="mb-1.5 block text-xs font-medium text-foreground">
                Tool
              </Label>
              <Select
                variant="secondary"
                selectedKey={selectedTool}
                onSelectionChange={(key) =>
                  setSelectedTool(String(key))
                }
                aria-label="Tool"
              >
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {runnableTools.map((t) => (
                      <ListBox.Item
                        key={t.id}
                        id={t.command}
                        textValue={`${t.command} (${t.name})`}
                      >
                        <span className="font-mono">{t.command}</span>
                        <span className="text-muted"> · {t.name}</span>
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>
            <div className="min-w-0">
              <Field label="Arguments">
                <div className="relative">
                  <span className="pointer-events-none absolute top-1/2 left-3 z-10 -translate-y-1/2 font-mono text-xs text-muted">
                    $
                  </span>
                  <TextInput
                    value={cmdArgs}
                    onChange={(e) => setCmdArgs(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleExecute();
                    }}
                    placeholder="--version"
                    aria-label="Arguments"
                    className="pl-7 font-mono text-sm"
                  />
                </div>
              </Field>
            </div>
            <Button
              variant="primary"
              isLoading={isRunning}
              disabled={isRunning || !selectedToolEnabled}
              icon={<Play />}
              onClick={handleExecute}
            >
              Run
            </Button>
          </div>

          <div className="min-h-16 border-t border-separator bg-background-secondary px-4 py-3 font-mono text-xs leading-relaxed">
            {isRunning ? (
              <p className="flex items-center gap-2 text-foreground">
                <Spinner size="sm" color="current" />
                <span>
                  $ {selectedTool} {cmdArgs}
                </span>
              </p>
            ) : cmdResult ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="truncate text-muted">
                    <span className="text-foreground">
                      $ {selectedTool} {cmdArgs}
                    </span>
                  </p>
                  <span className="flex shrink-0 items-center gap-1">
                    <Badge
                      variant={cmdResult.success ? "success" : "danger"}
                      dot
                    >
                      {cmdResult.success
                        ? "Exit 0"
                        : `Exit ${cmdResult.code}`}
                    </Badge>
                    <Button
                      variant="ghost"
                      iconOnly
                      icon={copiedOutput ? <Check /> : <Copy />}
                      onClick={handleCopyOutput}
                      aria-label={copiedOutput ? "Copied" : "Copy output"}
                      title="Copy output"
                    />
                    <Button
                      variant="ghost"
                      onClick={() => setCmdResult(null)}
                    >
                      Clear
                    </Button>
                  </span>
                </div>
                {cmdResult.stdout && (
                  <pre className=" max-h-48 overflow-y-auto whitespace-pre-wrap text-foreground">
                    {cmdResult.stdout}
                  </pre>
                )}
                {cmdResult.stderr && (
                  <pre className=" max-h-48 overflow-y-auto whitespace-pre-wrap text-danger">
                    {cmdResult.stderr}
                  </pre>
                )}
              </div>
            ) : (
              <p className="text-muted">
                $ <span className="opacity-60">▍</span>
                <span className="sr-only">
                  No command run yet. Pick a binary above and press Run.
                </span>
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Register custom CLI */}
      <Modal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        size="sm"
        icon={<Plus className="size-4" />}
        title="Register custom binary"
        description="Add any local agent executable or runner to the pipeline."
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowAddModal(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              isLoading={isAdding}
              disabled={isAdding || !customName || !customPath}
              onClick={handleAddCustom}
            >
              Register & probe
            </Button>
          </>
        }
      >
        <form onSubmit={handleAddCustom} className="space-y-4">
          <Field label="Tool name">
            <TextInput
              placeholder="e.g. My Custom Agent"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              required
              aria-label="Tool name"
            />
          </Field>
          <Field
            label="Command or absolute path"
            hint="A PATH command or a full path to the executable"
          >
            <TextInput
              placeholder="e.g. my-cli or C:\tools\my-cli.exe"
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
              required
              aria-label="Command or absolute path"
              className="font-mono"
            />
          </Field>
        </form>
      </Modal>
    </div>
  );
};
