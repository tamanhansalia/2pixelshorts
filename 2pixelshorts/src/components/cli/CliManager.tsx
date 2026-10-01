import React, { useState } from "react";
import { AnimatePresence } from "framer-motion";
import { 
  Terminal, 
  RefreshCw, 
  Plus, 
  Check, 
  Play, 
  Trash2, 
  Bot, 
  Layers, 
  Video, 
  Sparkles, 
  Code2,
  Loader2,
  Search,
  Copy
} from "lucide-react";
import { CliToolInfo, CommandOutput } from "../../types";
import { ToolCardSkeleton } from "../ui/Skeleton";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { Modal } from "../ui/Modal";

interface CliManagerProps {
  tools: CliToolInfo[];
  isLoading: boolean;
  onRefresh: () => void;
  onToggleTool: (id: string) => void;
  onRemoveTool: (id: string) => void;
  onAddCustomTool: (name: string, pathOrCmd: string) => Promise<void>;
  onRunCommand: (command: string, args: string[]) => Promise<CommandOutput>;
}

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
    if (!selectedTool) return;
    setIsRunning(true);
    try {
      const argsArray = cmdArgs.trim() ? cmdArgs.split(" ") : [];
      const res = await onRunCommand(selectedTool, argsArray);
      setCmdResult(res);
    } catch (err: any) {
      setCmdResult({
        success: false,
        code: -1,
        stdout: "",
        stderr: err?.toString() || "Execution failed",
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

  const agentCount = tools.filter((t) => t.category === "agent" && t.is_available).length;
  const mediaCount = tools.filter((t) => t.category === "media" && t.is_available).length;
  const availableCount = tools.filter((t) => t.is_available && t.is_enabled).length;

  const filteredTools = tools.filter((t) => {
    const matchesFilter =
      activeFilter === "all" ||
      (activeFilter === "agent" && t.category === "agent") ||
      (activeFilter === "media" && t.category === "media") ||
      (activeFilter === "runtime" && (t.category === "runtime" || t.category === "animation")) ||
      (activeFilter === "custom" && t.category === "custom");

    if (!matchesFilter) return false;

    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return (
      t.name.toLowerCase().includes(query) ||
      t.command.toLowerCase().includes(query) ||
      (t.description && t.description.toLowerCase().includes(query))
    );
  });

  return (
    <div className="space-y-4 max-w-6xl mx-auto font-sans select-none">
      {/* Top Action Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg bg-surface border border-border">
        <div className="flex items-center gap-2.5">
          <div className="h-6 w-6 rounded bg-surface-secondary border border-border flex items-center justify-center text-foreground shrink-0">
            <Terminal className="w-3.5 h-3.5" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground tracking-tight">
              CLI Tools & Agents
            </span>
            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-surface-secondary text-muted border border-border">
              {availableCount}/{tools.length} active
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 self-end sm:self-auto">
          <Button
            variant="secondary"
            size="xs"
            icon={<RefreshCw className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`} />}
            onClick={onRefresh}
            isLoading={isLoading}
          >
            Rescan PATH
          </Button>
          <Button
            variant="primary"
            size="xs"
            icon={<Plus className="w-3 h-3" />}
            onClick={() => setShowAddModal(true)}
          >
            Add Binary
          </Button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-2.5">
        {/* Category Filter Pills */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1 md:pb-0 scrollbar-none">
          {[
            { id: "all", label: "All Tools", icon: Layers, count: tools.length },
            { id: "agent", label: "AI Agents", icon: Bot, count: agentCount },
            { id: "media", label: "Media Engines", icon: Video, count: mediaCount },
            { id: "runtime", label: "Runtimes", icon: Sparkles },
            { id: "custom", label: "Custom", icon: Code2 },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeFilter === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveFilter(tab.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer outline-none whitespace-nowrap ${
                  isActive
                    ? "bg-foreground text-background font-semibold"
                    : "bg-surface text-muted hover:text-foreground border border-border"
                }`}
              >
                <Icon className="w-3 h-3" />
                <span>{tab.label}</span>
                {"count" in tab && (
                  <span className={`text-[10px] font-mono opacity-80`}>
                    ({tab.count})
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Search input */}
        <div className="relative w-full md:w-64">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tools or commands..."
            className="w-full pl-8 pr-3 py-1 rounded-md bg-field border border-border text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-foreground"
          />
        </div>
      </div>

      {/* Tools Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
        {isLoading ? (
          <>
            <ToolCardSkeleton />
            <ToolCardSkeleton />
            <ToolCardSkeleton />
            <ToolCardSkeleton />
            <ToolCardSkeleton />
            <ToolCardSkeleton />
          </>
        ) : filteredTools.length === 0 ? (
          <div className="col-span-full py-12 text-center rounded-lg bg-surface border border-border space-y-2">
            <div className="h-8 w-8 rounded-md bg-surface-secondary border border-border flex items-center justify-center mx-auto text-muted">
              <Terminal className="w-4 h-4 text-foreground" />
            </div>
            <div className="text-xs font-semibold text-foreground">No CLI Tools Found</div>
            <p className="text-[11px] text-muted max-w-sm mx-auto">
              No binaries match your current filter or search criteria.
            </p>
          </div>
        ) : (
          <AnimatePresence>
            {filteredTools.map((tool) => {
              const isAgent = tool.category === "agent";
              const isMedia = tool.category === "media";
              const CategoryIcon = isAgent ? Bot : isMedia ? Video : tool.category === "custom" ? Code2 : Sparkles;

              return (
                <div
                  key={tool.id}
                  className={`p-3 rounded-lg border transition-colors flex flex-col justify-between ${
                    tool.is_available && tool.is_enabled
                      ? "bg-surface border-border hover:border-muted/80"
                      : !tool.is_available
                      ? "bg-surface-secondary/40 border-border/50 opacity-60"
                      : "bg-surface-secondary border-border opacity-70"
                  }`}
                >
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="h-6 w-6 rounded bg-surface-secondary border border-border flex items-center justify-center text-foreground shrink-0">
                          <CategoryIcon className="w-3.5 h-3.5" />
                        </div>
                        <div className="min-w-0">
                          <span className="font-semibold text-foreground text-xs truncate block">
                            {tool.name}
                          </span>
                          <span className="text-[10px] font-mono text-muted block truncate">
                            ${tool.command}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {tool.category === "custom" && (
                          <button
                            type="button"
                            onClick={() => onRemoveTool(tool.id)}
                            aria-label="Remove tool"
                            className="p-1 rounded text-muted hover:text-danger transition cursor-pointer"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                        {tool.is_available && (
                          <button
                            type="button"
                            onClick={() => onToggleTool(tool.id)}
                            className={`text-[10px] px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                              tool.is_enabled
                                ? "bg-foreground text-background border-foreground font-semibold"
                                : "border-border text-muted bg-surface-secondary hover:text-foreground"
                            }`}
                          >
                            {tool.is_enabled ? "Enabled" : "Disabled"}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mt-2.5 pt-2 border-t border-border/60 flex items-center justify-between text-[11px]">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${tool.is_available ? "bg-success" : "bg-muted"}`} />
                      <span className={`text-[10px] font-mono truncate max-w-[130px] ${tool.is_available ? "text-foreground" : "text-muted"}`}>
                        {tool.is_available ? (tool.version || "Installed") : "Not in PATH"}
                      </span>
                    </div>

                    {tool.is_available && (
                      <button
                        type="button"
                        onClick={() => handleSelectToolForRun(tool.command)}
                        className="text-[10px] text-muted hover:text-foreground flex items-center gap-1 cursor-pointer font-medium"
                      >
                        <Play className="w-2.5 h-2.5 fill-current" />
                        <span>Run Test</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </AnimatePresence>
        )}
      </div>

      {/* Terminal Console Runner */}
      <div id="cli-runner-console" className="p-4 rounded-lg bg-surface border border-border space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            <h2 className="text-xs font-semibold text-foreground tracking-tight">
              Direct CLI Terminal Execution
            </h2>
          </div>
          <div className="flex items-center gap-1 text-[11px] text-muted">
            <span className="hidden sm:inline">Presets:</span>
            {["--version", "--help", "-v", "status"].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setCmdArgs(preset)}
                className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-surface-secondary hover:bg-surface-tertiary text-foreground border border-border cursor-pointer transition"
              >
                {preset}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          <div className="sm:col-span-1">
            <select
              value={selectedTool}
              onChange={(e) => setSelectedTool(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-md bg-field border border-border text-xs text-foreground focus:outline-none focus:border-foreground font-mono"
            >
              {tools
                .filter((t) => t.is_available && t.is_enabled)
                .map((t) => (
                  <option key={t.id} value={t.command}>
                    {t.command} ({t.name})
                  </option>
                ))}
            </select>
          </div>

          <div className="sm:col-span-2">
            <div className="relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted font-mono text-xs">
                $
              </span>
              <input
                type="text"
                value={cmdArgs}
                onChange={(e) => setCmdArgs(e.target.value)}
                placeholder="Arguments (e.g. --version or --help)"
                className="w-full pl-6 pr-3 py-1.5 rounded-md text-xs bg-field border border-border text-foreground placeholder:text-muted focus:outline-none focus:border-foreground font-mono"
              />
            </div>
          </div>

          <div className="sm:col-span-1">
            <Button
              variant="primary"
              size="sm"
              fullWidth
              isLoading={isRunning}
              disabled={isRunning || !selectedTool}
              icon={<Play className="w-3 h-3 fill-current" />}
              onClick={handleExecute}
            >
              Execute
            </Button>
          </div>
        </div>

        <AnimatePresence>
          {isRunning && (
            <div className="rounded-md bg-surface-secondary border border-border p-2.5 text-xs">
              <div className="flex items-center gap-2 text-muted text-xs">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-foreground" />
                <span className="font-mono text-[11px] text-foreground">
                  Running: {selectedTool} {cmdArgs}...
                </span>
              </div>
            </div>
          )}

          {cmdResult && (
            <div className="rounded-md bg-surface-secondary border border-border p-3 text-xs space-y-2">
              <div className="flex items-center justify-between text-muted border-b border-border pb-1.5">
                <div className="flex items-center gap-2">
                  <Badge variant={cmdResult.success ? "success" : "danger"} size="xs" dot>
                    {cmdResult.success ? "Exit Code 0" : `Exit Code ${cmdResult.code}`}
                  </Badge>
                  <span className="text-[11px] font-mono text-muted">
                    {selectedTool} {cmdArgs}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={copiedOutput ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                    onClick={handleCopyOutput}
                  >
                    {copiedOutput ? "Copied" : "Copy"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setCmdResult(null)}
                  >
                    Clear
                  </Button>
                </div>
              </div>

              {cmdResult.stdout && (
                <pre className="text-foreground whitespace-pre-wrap max-h-48 overflow-y-auto font-mono text-[11px] bg-background/50 p-2 rounded border border-border/40">
                  {cmdResult.stdout}
                </pre>
              )}

              {cmdResult.stderr && (
                <pre className="text-danger whitespace-pre-wrap max-h-48 overflow-y-auto font-mono text-[11px] bg-danger/5 p-2 rounded border border-danger/20">
                  {cmdResult.stderr}
                </pre>
              )}
            </div>
          )}
        </AnimatePresence>
      </div>

      {/* Register Custom CLI Modal Dialog */}
      <Modal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        title="Register Custom CLI Binary"
        description="Add any local AI agent executable, Python runner, or custom binary to the TUARI V2 orchestration pipeline."
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowAddModal(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              isLoading={isAdding}
              disabled={isAdding || !customName || !customPath}
              onClick={handleAddCustom}
            >
              Register & Probe Binary
            </Button>
          </>
        }
      >
        <form onSubmit={handleAddCustom} className="space-y-3.5">
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">
              Tool Label / Name
            </label>
            <input
              type="text"
              placeholder="e.g. My Custom Agent CLI"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              className="w-full px-3 py-2 rounded-md text-xs bg-field border border-border text-foreground placeholder:text-muted focus:outline-none focus:border-foreground"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">
              Executable Command or Absolute Binary Path
            </label>
            <input
              type="text"
              placeholder="e.g. my-cli or C:\tools\my-cli.exe"
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
              className="w-full px-3 py-2 rounded-md text-xs bg-field border border-border text-foreground placeholder:text-muted focus:outline-none focus:border-foreground font-mono"
              required
            />
          </div>
        </form>
      </Modal>
    </div>
  );
};
