import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ActivityIcon,
  ArrowUpRightIcon,
  CircleAlertIcon,
  FileTextIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  PlayIcon,
  RefreshCcwIcon,
  ScanSearchIcon,
  Settings2Icon,
  SparklesIcon,
  SquareIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type {
  ConversionItem,
  ConversionJob,
  ConversionProgress,
  ConversionRunResult,
  RuntimeSource,
  RuntimeStatus,
  SourceKind,
} from "./types";

const APP_VERSION = "1.1.0";

const EMPTY_PROGRESS: ConversionProgress = {
  totalCount: 0,
  processedCount: 0,
  convertedCount: 0,
  skippedCount: 0,
  failedCount: 0,
  fractionCompleted: 0,
  currentFile: null,
};

type ActiveView = "convert" | "execution" | "results" | "settings";

const NAV_ITEMS: Array<{
  id: ActiveView;
  label: string;
  hint: string;
  icon: typeof ActivityIcon;
}> = [
  {
    id: "convert",
    label: "转换工作台",
    hint: "源文件与目标目录",
    icon: ScanSearchIcon,
  },
  {
    id: "execution",
    label: "批量执行",
    hint: "队列与实时诊断",
    icon: ActivityIcon,
  },
  {
    id: "results",
    label: "结果与历史",
    hint: "记录与输出回看",
    icon: FileTextIcon,
  },
  {
    id: "settings",
    label: "运行时设置",
    hint: "运行时探测与更新",
    icon: Settings2Icon,
  },
];

function App() {
  const [activeView, setActiveView] = useState<ActiveView>("convert");
  const [sourcePath, setSourcePath] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
  const [destinationPath, setDestinationPath] = useState("");
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [progress, setProgress] = useState<ConversionProgress>(EMPTY_PROGRESS);
  const [items, setItems] = useState<ConversionItem[]>([]);
  const [activityMessage, setActivityMessage] = useState("准备就绪");
  const [isConverting, setIsConverting] = useState(false);
  const [isCheckingRuntime, setIsCheckingRuntime] = useState(false);
  const [isUpdatingRuntime, setIsUpdatingRuntime] = useState(false);
  const [resultsQuery, setResultsQuery] = useState("");
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [lastRunResult, setLastRunResult] = useState<ConversionRunResult | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    void (async () => {
      unlisten = await listen<ConversionProgress>("conversion-progress", (event) => {
        const payload = event.payload;
        if (typeof payload !== "object" || payload === null || !("totalCount" in payload)) {
          return;
        }

        setProgress(payload);
        if (payload.currentFile) {
          setActivityMessage(`正在转换：${basename(payload.currentFile)}`);
        } else if (payload.totalCount > 0) {
          setActivityMessage(progressDescription(payload));
        } else {
          setActivityMessage("未发现可处理文件。");
        }
      });
    })();

    return () => {
      void unlisten?.();
    };
  }, []);

  useEffect(() => {
    void refreshRuntimeStatus(true);
  }, []);

  useEffect(() => {
    if (items.length === 0) {
      if (selectedItemKey !== null) {
        setSelectedItemKey(null);
      }
      return;
    }

    const hasSelected = selectedItemKey
      ? items.some((item) => itemKey(item) === selectedItemKey)
      : false;

    if (!hasSelected) {
      setSelectedItemKey(itemKey(items[items.length - 1]));
    }
  }, [items, selectedItemKey]);

  const progressPercent = Math.round(progress.fractionCompleted * 100);
  const successRate = progress.totalCount > 0
    ? Math.round((progress.convertedCount / progress.totalCount) * 100)
    : 0;
  const canStart = Boolean(sourcePath && destinationPath && sourceKind) && !isConverting;
  const latestItem = items.length > 0 ? items[items.length - 1] : null;
  const latestFailure = findLatestFailure(items);
  const runState = runStateLabel(isConverting, items.length > 0, progress.failedCount);
  const runBadge = runBadgeVariant(isConverting, items.length > 0, progress.failedCount);
  const filteredItems = filterItems(items, resultsQuery);
  const selectedItem = items.find((item) => itemKey(item) === selectedItemKey) ?? latestItem;
  const queueEntries = buildQueueEntries(progress, items, activityMessage);
  const currentView = viewContent(activeView);
  const executionRate = formatExecutionRate(progress, runStartedAt, isConverting, lastRunResult);

  async function refreshRuntimeStatus(fetchLatest: boolean) {
    setIsCheckingRuntime(true);
    try {
      const status = await invoke<RuntimeStatus>("scan_runtime_status", { fetchLatest });
      setRuntimeStatus(status);
    } catch (error) {
      const message = `运行时状态获取失败：${stringifyError(error)}`;
      setActivityMessage(message);
      toast.error(message);
    } finally {
      setIsCheckingRuntime(false);
    }
  }

  async function chooseSource(kind: SourceKind) {
    try {
      const selected = await invoke<string | null>("pick_source", { kind });
      if (!selected) {
        return;
      }

      setSourceKind(kind);
      setSourcePath(selected);
      setActivityMessage(`源路径已更新：${basename(selected)}`);
    } catch (error) {
      const message = `源路径选择失败：${stringifyError(error)}`;
      setActivityMessage(message);
      toast.error(message);
    }
  }

  async function chooseDestination() {
    try {
      const selected = await invoke<string | null>("pick_destination");
      if (!selected) {
        return;
      }

      setDestinationPath(selected);
      setActivityMessage(`目标目录已更新：${basename(selected)}`);
    } catch (error) {
      const message = `目标目录选择失败：${stringifyError(error)}`;
      setActivityMessage(message);
      toast.error(message);
    }
  }

  async function installRuntimeIfNeeded() {
    setIsUpdatingRuntime(true);
    try {
      const status = await invoke<RuntimeStatus>("install_runtime_if_needed");
      setRuntimeStatus(status);
      return status;
    } finally {
      setIsUpdatingRuntime(false);
    }
  }

  async function startConversion() {
    if (!sourcePath || !destinationPath || !sourceKind || isConverting) {
      return;
    }

    cancelledRef.current = false;
    setItems([]);
    setSelectedItemKey(null);
    setProgress(EMPTY_PROGRESS);
    setLastRunResult(null);
    setRunStartedAt(Date.now());
    setActivityMessage("正在准备 MarkItDown 运行时…");
    setIsConverting(true);
    setActiveView("execution");

    try {
      const runtime = runtimeStatus?.isReady ? runtimeStatus : await installRuntimeIfNeeded();
      setRuntimeStatus(runtime);

      const job: ConversionJob = {
        sourceUrl: sourcePath,
        sourceKind,
        destinationRoot: destinationPath,
      };

      const result = await invoke<ConversionRunResult>("start_conversion", { job });
      setItems(result.items);
      setLastRunResult(result);

      if (result.cancelled || cancelledRef.current) {
        setActivityMessage("转换已取消。");
        toast("转换已取消。");
      } else {
        const summaryMessage = `转换完成：成功 ${result.summary.converted}，失败 ${result.summary.failed}，跳过 ${result.summary.skipped}。`;
        setActivityMessage(summaryMessage);
        toast.success(summaryMessage);
      }
    } catch (error) {
      const message = `转换失败：${stringifyError(error)}`;
      setActivityMessage(message);
      toast.error(message);
    } finally {
      setIsConverting(false);
      setRunStartedAt(null);
      cancelledRef.current = false;
    }
  }

  async function cancelConversion() {
    if (!isConverting) {
      return;
    }

    cancelledRef.current = true;
    try {
      await invoke("cancel_conversion");
      setActivityMessage("正在取消转换…");
      toast("正在取消转换…");
    } catch (error) {
      const message = `取消失败：${stringifyError(error)}`;
      setActivityMessage(message);
      toast.error(message);
    }
  }

  async function openDestination() {
    if (!destinationPath) {
      return;
    }

    try {
      await invoke("open_destination_in_finder", { path: destinationPath });
    } catch (error) {
      const message = `打开 Finder 失败：${stringifyError(error)}`;
      setActivityMessage(message);
      toast.error(message);
    }
  }

  async function checkUpdate() {
    setIsCheckingRuntime(true);
    try {
      const status = await invoke<RuntimeStatus>("check_runtime_update");
      setRuntimeStatus(status);
      if (status.hasUpdateAvailable) {
        toast.success(`发现新版本 ${status.latestVersion ?? ""}`.trim());
      } else {
        toast("当前已是最新稳定版。");
      }
    } catch (error) {
      const message = `检查更新失败：${stringifyError(error)}`;
      setActivityMessage(message);
      toast.error(message);
    } finally {
      setIsCheckingRuntime(false);
    }
  }

  async function updateRuntime() {
    if (!runtimeStatus?.supportsInAppUpdate) {
      const message = "当前运行时来源不支持应用内更新。";
      setActivityMessage(message);
      toast(message);
      return;
    }

    setIsUpdatingRuntime(true);
    setActivityMessage("正在同步 MarkItDown 运行时…");
    try {
      const status = await invoke<RuntimeStatus>("update_runtime");
      setRuntimeStatus(status);
      const message = status.hasUpdateAvailable
        ? "检测到新版本。"
        : "MarkItDown 已准备就绪。";
      setActivityMessage(message);
      toast.success(message);
    } catch (error) {
      const message = `运行时更新失败：${stringifyError(error)}`;
      setActivityMessage(message);
      toast.error(message);
    } finally {
      setIsUpdatingRuntime(false);
    }
  }

  function handleSourceKindChange(value: string) {
    if (value !== "file" && value !== "directory") {
      return;
    }

    if (value === sourceKind) {
      return;
    }

    setSourceKind(value);
    setSourcePath("");
    setItems([]);
    setProgress(EMPTY_PROGRESS);
    setActivityMessage(value === "file" ? "已切换为单文件入口。" : "已切换为目录入口。");
  }

  function handleChooseSource() {
    if (!sourceKind) {
      toast("请先选择源类型。");
      return;
    }

    void chooseSource(sourceKind);
  }

  return (
    <>
      <Toaster />

      <main className="app-shell">
        <div className="app-frame">
          <SidebarNav
            activeView={activeView}
            destinationPath={destinationPath}
            items={items}
            onChange={setActiveView}
            progressPercent={progressPercent}
            runtimeStatus={runtimeStatus}
            sourcePath={sourcePath}
          />

          <section className="app-workspace">
            <header className="workspace-header">
              <div className="flex min-w-0 flex-col gap-3">
                <p className="workspace-eyebrow">MARKITDOWN 转换器</p>
                <div className="flex min-w-0 flex-col gap-2">
                  <h1 className="workspace-title">{currentView.title}</h1>
                  <p className="workspace-description">{currentView.description}</p>
                </div>
              </div>

              <div className="workspace-header__status">
                <StatusBadge label={runtimeStatus?.isReady ? "运行时已就绪" : "需要运行时"} variant={runtimeStatus?.isReady ? "secondary" : "outline"} />
                <StatusBadge label={runState} variant={runBadge} />
                <StatusBadge label={`v${APP_VERSION}`} variant="outline" />
              </div>
            </header>

            {activeView === "convert" ? (
              <ConvertView
                activityMessage={activityMessage}
                canStart={canStart}
                destinationPath={destinationPath}
                handleChooseSource={handleChooseSource}
                isCheckingRuntime={isCheckingRuntime}
                isConverting={isConverting}
                onCancel={cancelConversion}
                onChooseDestination={chooseDestination}
                onOpenDestination={openDestination}
                onRefreshRuntime={() => {
                  void refreshRuntimeStatus(true);
                }}
                onSourceKindChange={handleSourceKindChange}
                onStart={startConversion}
                progress={progress}
                progressPercent={progressPercent}
                runtimeStatus={runtimeStatus}
                sourceKind={sourceKind}
                sourcePath={sourcePath}
                successRate={successRate}
              />
            ) : null}

            {activeView === "execution" ? (
              <ExecutionView
                activityMessage={activityMessage}
                executionRate={executionRate}
                isConverting={isConverting}
                latestFailure={latestFailure}
                lastRunResult={lastRunResult}
                progress={progress}
                progressPercent={progressPercent}
                queueEntries={queueEntries}
              />
            ) : null}

            {activeView === "results" ? (
              <ResultsView
                canStart={canStart}
                filteredItems={filteredItems}
                items={items}
                onQueryChange={setResultsQuery}
                onSelectItem={setSelectedItemKey}
                onStart={startConversion}
                query={resultsQuery}
                selectedItem={selectedItem}
              />
            ) : null}

            {activeView === "settings" ? (
              <SettingsView
                isCheckingRuntime={isCheckingRuntime}
                isUpdatingRuntime={isUpdatingRuntime}
                onCheckUpdate={checkUpdate}
                onRefreshRuntime={() => {
                  void refreshRuntimeStatus(true);
                }}
                onUpdateRuntime={updateRuntime}
                runtimeStatus={runtimeStatus}
              />
            ) : null}
          </section>

          <ContextPanel
            activeView={activeView}
            activityMessage={activityMessage}
            destinationPath={destinationPath}
            executionRate={executionRate}
            latestFailure={latestFailure}
            lastRunResult={lastRunResult}
            progress={progress}
            progressPercent={progressPercent}
            runtimeStatus={runtimeStatus}
            selectedItem={selectedItem}
          />
        </div>
      </main>
    </>
  );
}

function SidebarNav(props: {
  activeView: ActiveView;
  destinationPath: string;
  items: ConversionItem[];
  onChange: (view: ActiveView) => void;
  progressPercent: number;
  runtimeStatus: RuntimeStatus | null;
  sourcePath: string;
}) {
  return (
    <aside className="app-sidebar">
      <div className="app-sidebar__brand">
        <div>
          <p className="workspace-eyebrow">工作区</p>
          <div className="app-brand-title">MarkItDown</div>
        </div>
        <StatusBadge label="转换器" variant="outline" />
      </div>

      <nav className="app-nav">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;

          return (
            <Button
              className="app-nav-button"
              data-active={item.id === props.activeView}
              key={item.id}
              onClick={() => props.onChange(item.id)}
              variant={item.id === props.activeView ? "secondary" : "ghost"}
            >
              <Icon data-icon="inline-start" />
              <span className="app-nav-button__copy">
                <span className="app-nav-button__label">{item.label}</span>
                <span className="app-nav-button__hint">{item.hint}</span>
              </span>
              <Badge className="ml-auto" variant={navBadgeVariant(item.id, props.runtimeStatus, props.items)}>
                {navBadgeLabel(item.id, props.progressPercent, props.items.length, props.runtimeStatus)}
              </Badge>
            </Button>
          );
        })}
      </nav>

      <Separator />

      <div className="sidebar-session">
        <p className="workspace-eyebrow">当前会话</p>
        <div className="sidebar-session__row">
          <span>源路径</span>
          <span>{props.sourcePath ? basename(props.sourcePath) : "未选择"}</span>
        </div>
        <div className="sidebar-session__row">
          <span>目标目录</span>
          <span>{props.destinationPath ? basename(props.destinationPath) : "待设置"}</span>
        </div>
        <p className="sidebar-session__note">
          搜索、执行、运行时维护和结果回看都集中在同一个工作区中。
        </p>
      </div>
    </aside>
  );
}

function ConvertView(props: {
  activityMessage: string;
  canStart: boolean;
  destinationPath: string;
  handleChooseSource: () => void;
  isCheckingRuntime: boolean;
  isConverting: boolean;
  onCancel: () => void;
  onChooseDestination: () => void;
  onOpenDestination: () => void;
  onRefreshRuntime: () => void;
  onSourceKindChange: (value: string) => void;
  onStart: () => void;
  progress: ConversionProgress;
  progressPercent: number;
  runtimeStatus: RuntimeStatus | null;
  sourceKind: SourceKind | null;
  sourcePath: string;
  successRate: number;
}) {
  return (
    <div className="workspace-stack">
      <div className="metric-grid metric-grid--three">
        <MetricTile
          detail={props.progress.totalCount > 0 ? "按文件粒度推进" : "等待扫描"}
          label="已处理"
          value={`${props.progress.processedCount} / ${props.progress.totalCount}`}
        />
        <MetricTile
          detail={`成功 ${props.progress.convertedCount} · 失败 ${props.progress.failedCount}`}
          label="成功率"
          value={`${props.successRate}%`}
        />
        <MetricTile
          detail={props.runtimeStatus?.latestVersion ? `最新稳定版 ${props.runtimeStatus.latestVersion}` : "尚未检查最新版本"}
          label="运行时版本"
          value={props.runtimeStatus?.installedVersion ?? "-"}
        />
      </div>

      <section className="surface-panel">
        <div className="surface-panel__header">
          <div className="surface-panel__copy">
            <p className="surface-panel__eyebrow">源与目标</p>
            <h2 className="surface-panel__title">源与目标</h2>
            <p className="surface-panel__description">
              为当前任务选择一个源入口和一个目标根目录。输出会保留相对层级，并统一改写为 `.md` 扩展名。
            </p>
          </div>
          <div className="surface-panel__actions">
            <StatusBadge label={props.sourceKind ? sourceKindLabel(props.sourceKind) : "请选择源类型"} variant="outline" />
            <StatusBadge label={props.runtimeStatus?.isReady ? "运行时已就绪" : "需要运行时"} variant={props.runtimeStatus?.isReady ? "secondary" : "outline"} />
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.72fr)]">
          <div className="flex flex-col gap-6">
            <FieldSet>
              <FieldLegend variant="label">执行设置</FieldLegend>
              <FieldDescription>
                目录扫描时会跳过隐藏文件。即使是不支持的文件，也会计入已处理进度。
              </FieldDescription>
              <FieldGroup className="gap-5">
                <Field orientation="responsive">
                  <FieldContent>
                    <FieldTitle>源类型</FieldTitle>
                    <FieldDescription>决定本次任务是处理单个文件，还是递归处理整个目录。</FieldDescription>
                  </FieldContent>
                  <ToggleGroup
                    onValueChange={props.onSourceKindChange}
                    spacing={2}
                    type="single"
                    value={props.sourceKind ?? undefined}
                    variant="outline"
                  >
                    <ToggleGroupItem value="file">
                      <FileTextIcon data-icon="inline-start" />
                      单文件
                    </ToggleGroupItem>
                    <ToggleGroupItem value="directory">
                      <FolderTreeIcon data-icon="inline-start" />
                      文件夹
                    </ToggleGroupItem>
                  </ToggleGroup>
                </Field>

                <Field>
                  <FieldLabel htmlFor="source-path">源路径</FieldLabel>
                  <FieldDescription>
                    {props.sourceKind
                      ? `当前模式：${sourceKindLabel(props.sourceKind)}`
                      : "请先选择源类型，再打开系统选择面板。"}
                  </FieldDescription>
                  <InputGroup>
                    <InputGroupInput
                      id="source-path"
                      placeholder={props.sourceKind ? "尚未选择源路径" : "请先选择源类型"}
                      readOnly
                      value={props.sourcePath}
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton disabled={!props.sourceKind} onClick={props.handleChooseSource} variant="secondary">
                        <FolderOpenIcon data-icon="inline-start" />
                        浏览
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                </Field>

                <Field>
                  <FieldLabel htmlFor="destination-path">目标根目录</FieldLabel>
                  <FieldDescription>每个文件转换完成后，会以原子替换方式覆盖已有同名文件。</FieldDescription>
                  <InputGroup>
                    <InputGroupInput
                      id="destination-path"
                      placeholder="尚未选择目标根目录"
                      readOnly
                      value={props.destinationPath}
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton onClick={props.onChooseDestination} variant="secondary">
                        <FolderOpenIcon data-icon="inline-start" />
                        浏览
                      </InputGroupButton>
                      <InputGroupButton disabled={!props.destinationPath} onClick={props.onOpenDestination} variant="ghost">
                        <ArrowUpRightIcon data-icon="inline-start" />
                        打开
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                </Field>
              </FieldGroup>
            </FieldSet>

            <div className="surface-panel__footer">
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={!props.canStart} onClick={props.onStart}>
                  {props.isConverting ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
                  开始转换
                </Button>
                <Button disabled={!props.isConverting} onClick={props.onCancel} variant="outline">
                  <SquareIcon data-icon="inline-start" />
                  取消
                </Button>
                <Button disabled={props.isCheckingRuntime} onClick={props.onRefreshRuntime} variant="ghost">
                  {props.isCheckingRuntime ? <Spinner data-icon="inline-start" /> : <RefreshCcwIcon data-icon="inline-start" />}
                  刷新运行时
                </Button>
              </div>
              <StatusBadge label={props.canStart ? "可以开始" : "等待必要路径"} variant={props.canStart ? "secondary" : "outline"} />
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <InfoPanel
              detail="发生同名冲突时，会先写临时文件，再替换目标文件，避免产生半成品。"
              label="覆盖策略"
              value="原子替换"
            />
            <InfoPanel
              detail={runtimeDetail(props.runtimeStatus)}
              label="运行时解析"
              value={runtimeHeader(props.runtimeStatus)}
            />
            <InfoPanel
              detail={props.activityMessage}
              label="当前执行状态"
              value={props.progress.currentFile ? basename(props.progress.currentFile) : `已完成 ${props.progressPercent}%`}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function ExecutionView(props: {
  activityMessage: string;
  executionRate: string;
  isConverting: boolean;
  latestFailure: ConversionItem | null;
  lastRunResult: ConversionRunResult | null;
  progress: ConversionProgress;
  progressPercent: number;
  queueEntries: QueueEntry[];
}) {
  return (
    <div className="workspace-stack">
      <section className="surface-panel">
        <div className="surface-panel__header">
          <div className="surface-panel__copy">
            <p className="surface-panel__eyebrow">执行时间线</p>
            <h2 className="surface-panel__title">执行时间线</h2>
            <p className="surface-panel__description">
              进度按文件级推进。成功、失败和跳过都会一起推动总完成度前进。
            </p>
          </div>
          <div className="surface-panel__actions">
            <StatusBadge label={props.isConverting ? "正在转换" : "等待新批次"} variant={props.isConverting ? "default" : "outline"} />
            <StatusBadge label={`队列中文件 ${props.progress.totalCount}`} variant="outline" />
          </div>
        </div>

        <div className="metric-grid metric-grid--three">
          <MetricTile
            detail={props.progress.totalCount > 0 ? `运行时已就绪 · ${props.progress.processedCount} / ${props.progress.totalCount}` : "队列待启动"}
            label="转换进度"
            value={`${props.progressPercent}%`}
          />
          <MetricTile
            detail={props.progress.skippedCount > 0 ? `已按预期跳过 ${props.progress.skippedCount} 个文件` : "失败项会持续保留在结果中"}
            label="失败数"
            value={`${props.progress.failedCount}`}
          />
          <MetricTile
            detail={props.progress.currentFile ? basename(props.progress.currentFile) : props.activityMessage}
            label="处理速度"
            value={props.executionRate}
          />
        </div>
      </section>

      <section className="surface-panel surface-panel--fill">
        <div className="surface-panel__header">
          <div className="surface-panel__copy">
            <p className="surface-panel__eyebrow">队列活动</p>
            <h2 className="surface-panel__title">队列活动</h2>
            <p className="surface-panel__description">
              这里展示最近处理过的文件，重点保留执行中、完成、跳过和失败的记录。
            </p>
          </div>
        </div>

        {props.queueEntries.length === 0 ? (
          <Empty className="empty-panel">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ActivityIcon />
              </EmptyMedia>
              <EmptyTitle>执行流还是空的</EmptyTitle>
              <EmptyDescription>开始一次转换后，这里会逐步累积执行记录。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="h-[26rem]">
            <div className="list-stack pr-2">
              {props.queueEntries.map((entry) => (
                <div className="list-row" key={entry.id}>
                  <div className="list-row__content">
                    <div className="list-row__title-group">
                      <StatusBadge label={entry.stateLabel} variant={entry.badgeVariant} />
                      <span className="list-row__title">{entry.title}</span>
                    </div>
                    <p className="list-row__detail">{entry.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}

        {props.latestFailure ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>最近失败</AlertTitle>
            <AlertDescription>{props.latestFailure.errorMessage ?? "转换失败。"}</AlertDescription>
          </Alert>
        ) : props.lastRunResult ? (
          <Alert>
            <SparklesIcon />
            <AlertTitle>最近完成的批次</AlertTitle>
            <AlertDescription>
              成功 {props.lastRunResult.summary.converted}，跳过 {props.lastRunResult.summary.skipped}，失败 {props.lastRunResult.summary.failed}。
            </AlertDescription>
          </Alert>
        ) : null}
      </section>
    </div>
  );
}

function ResultsView(props: {
  canStart: boolean;
  filteredItems: ConversionItem[];
  items: ConversionItem[];
  onQueryChange: (value: string) => void;
  onSelectItem: (key: string) => void;
  onStart: () => void;
  query: string;
  selectedItem: ConversionItem | null;
}) {
  const needsAttention = props.items.filter((item) => item.state === "failed").length;

  return (
    <div className="workspace-stack">
      <section className="surface-panel">
        <div className="surface-panel__header">
          <div className="surface-panel__copy">
            <p className="surface-panel__eyebrow">搜索与筛选</p>
            <h2 className="surface-panel__title">搜索与筛选</h2>
            <p className="surface-panel__description">
              可以按源路径、输出路径或错误内容检索当前结果流，快速缩小范围。
            </p>
          </div>
        </div>

        <InputGroup>
          <InputGroupAddon align="inline-start">
            <InputGroupText>
              <ScanSearchIcon />
            </InputGroupText>
          </InputGroupAddon>
          <InputGroupInput
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder="搜索源路径、输出路径或错误信息"
            value={props.query}
          />
        </InputGroup>
      </section>

      <div className="metric-grid metric-grid--two">
        <MetricTile
          detail="成功生成的 Markdown 数量"
          label="已完成"
          value={`${props.items.filter((item) => item.state === "converted").length}`}
        />
        <MetricTile
          detail="失败和跳过的记录数"
          label="需要关注"
          value={`${needsAttention + props.items.filter((item) => item.state === "skipped").length}`}
        />
      </div>

      <section className="surface-panel surface-panel--fill">
        <div className="surface-panel__header">
          <div className="surface-panel__copy">
            <p className="surface-panel__eyebrow">结果流</p>
            <h2 className="surface-panel__title">结果流</h2>
            <p className="surface-panel__description">
              每个处理过的文件都会保留输出路径、状态和错误上下文，便于后续回看。
            </p>
          </div>
          <div className="surface-panel__actions">
            <StatusBadge label={`可见记录 ${props.filteredItems.length}`} variant="outline" />
          </div>
        </div>

        {props.items.length === 0 ? (
          <Empty className="empty-panel">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SparklesIcon />
              </EmptyMedia>
              <EmptyTitle>还没有结果</EmptyTitle>
              <EmptyDescription>执行第一次转换后，这里会生成可搜索的结果记录。</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button disabled={!props.canStart} onClick={props.onStart}>
                <PlayIcon data-icon="inline-start" />
                开始首次转换
              </Button>
            </EmptyContent>
          </Empty>
        ) : props.filteredItems.length === 0 ? (
          <Empty className="empty-panel">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ScanSearchIcon />
              </EmptyMedia>
              <EmptyTitle>没有匹配记录</EmptyTitle>
              <EmptyDescription>调整搜索条件后，可以重新扩大当前结果集。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="h-[28rem]">
            <div className="list-stack pr-2">
              {props.filteredItems.map((item) => (
                <button
                  className={cn("list-row list-row--interactive", props.selectedItem && itemKey(item) === itemKey(props.selectedItem) && "is-selected")}
                  key={itemKey(item)}
                  onClick={() => props.onSelectItem(itemKey(item))}
                  type="button"
                >
                  <div className="list-row__content">
                    <div className="list-row__title-group">
                      <StatusBadge label={itemStateLabel(item.state)} variant={itemVariant(item.state)} />
                      <span className="list-row__title">{basename(item.sourceUrl)}</span>
                    </div>
                    <p className="list-row__detail">{item.errorMessage ?? itemSnapshot(item)}</p>
                  </div>
                  <PathCode value={item.outputUrl} />
                </button>
              ))}
            </div>
          </ScrollArea>
        )}
      </section>
    </div>
  );
}

function SettingsView(props: {
  isCheckingRuntime: boolean;
  isUpdatingRuntime: boolean;
  onCheckUpdate: () => void;
  onRefreshRuntime: () => void;
  onUpdateRuntime: () => void;
  runtimeStatus: RuntimeStatus | null;
}) {
  return (
    <div className="workspace-stack">
      <div className="metric-grid metric-grid--two">
        <MetricTile
          detail={props.runtimeStatus?.isReady ? "可用于当前转换任务" : "当前没有可用运行时"}
          label="已安装版本"
          value={props.runtimeStatus?.installedVersion ?? "-"}
        />
        <MetricTile
          detail={props.runtimeStatus?.hasUpdateAvailable ? "检测到更高版本稳定版" : "当前已与最新稳定版一致"}
          label="最新稳定版"
          value={props.runtimeStatus?.latestVersion ?? "-"}
        />
      </div>

      <section className="surface-panel">
        <div className="surface-panel__header">
          <div className="surface-panel__copy">
            <p className="surface-panel__eyebrow">解析顺序</p>
            <h2 className="surface-panel__title">解析顺序</h2>
            <p className="surface-panel__description">
              运行时总是按照固定顺序探测可用来源，并把最终使用的可执行文件展示在这里。
            </p>
          </div>
        </div>

        <div className="resolution-list">
          <ResolutionRow
            active={props.runtimeStatus?.runtimeSource === "codex_shared"}
            description="如果 Codex 已提供共享 markitdown 运行时，会优先复用这一来源。"
            label="Codex 共享运行时"
          />
          <ResolutionRow
            active={props.runtimeStatus?.runtimeSource === "system_existing"}
            description="如果系统中已经存在运行时，也可以直接复用，但维护仍在应用之外。"
            label="系统现有运行时"
          />
          <ResolutionRow
            active={props.runtimeStatus?.runtimeSource === "app_managed"}
            description="当没有可复用的可执行文件时，应用会按需创建自己的私有运行时。"
            label="应用私有运行时"
          />
        </div>
      </section>

      <section className="surface-panel">
        <div className="surface-panel__header">
          <div className="surface-panel__copy">
            <p className="surface-panel__eyebrow">维护</p>
            <h2 className="surface-panel__title">维护</h2>
            <p className="surface-panel__description">
              只有由应用自身托管的运行时，才支持在应用内直接更新。
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={props.isUpdatingRuntime || !props.runtimeStatus?.supportsInAppUpdate} onClick={props.onUpdateRuntime}>
            {props.isUpdatingRuntime ? <Spinner data-icon="inline-start" /> : <SparklesIcon data-icon="inline-start" />}
            {props.runtimeStatus?.isReady
              ? props.runtimeStatus.hasUpdateAvailable
                ? "更新运行时"
                : "重新安装运行时"
              : "安装运行时"}
          </Button>
          <Button disabled={props.isCheckingRuntime || props.isUpdatingRuntime} onClick={props.onCheckUpdate} variant="outline">
            {props.isCheckingRuntime ? <Spinner data-icon="inline-start" /> : <RefreshCcwIcon data-icon="inline-start" />}
            检查更新
          </Button>
          <Button disabled={props.isCheckingRuntime} onClick={props.onRefreshRuntime} variant="ghost">
            <RefreshCcwIcon data-icon="inline-start" />
            刷新状态
          </Button>
        </div>

        {props.runtimeStatus?.lastError ? (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>最近错误</AlertTitle>
            <AlertDescription>{props.runtimeStatus.lastError}</AlertDescription>
          </Alert>
        ) : null}
      </section>
    </div>
  );
}

function ContextPanel(props: {
  activeView: ActiveView;
  activityMessage: string;
  destinationPath: string;
  executionRate: string;
  latestFailure: ConversionItem | null;
  lastRunResult: ConversionRunResult | null;
  progress: ConversionProgress;
  progressPercent: number;
  runtimeStatus: RuntimeStatus | null;
  selectedItem: ConversionItem | null;
}) {
  return (
    <aside className="app-inspector">
      <div className="inspector-header">
        <p className="workspace-eyebrow">检查面板</p>
        <h2 className="inspector-title">{inspectorTitle(props.activeView)}</h2>
      </div>

      <ScrollArea className="h-full">
        <div className="inspector-stack pr-2">
          {props.activeView === "convert" ? (
            <>
              <InspectorBlock title="当前批次">
                <StatusBadge label={runStateLabel(false, props.progress.processedCount > 0, props.progress.failedCount)} variant={props.progress.failedCount > 0 ? "destructive" : props.progress.processedCount > 0 ? "secondary" : "outline"} />
                <div className="inspector-hero">{props.progressPercent}%</div>
                <p className="inspector-copy">{props.activityMessage}</p>
                <Progress className="h-2" value={props.progressPercent} />
              </InspectorBlock>

              <InspectorBlock title="质量报告">
                <InspectorStat label="成功" value={`${props.progress.convertedCount}`} />
                <InspectorStat label="失败" value={`${props.progress.failedCount}`} />
                <InspectorStat label="跳过" value={`${props.progress.skippedCount}`} />
              </InspectorBlock>

              <InspectorBlock title="运行时详情">
                <p className="inspector-copy">{runtimeDetail(props.runtimeStatus)}</p>
                <PathCode value={props.runtimeStatus?.executablePath ?? "可执行文件路径不可用"} />
              </InspectorBlock>
            </>
          ) : null}

          {props.activeView === "execution" ? (
            <>
              <InspectorBlock title="吞吐">
                <div className="inspector-hero inspector-hero--small">{props.executionRate}</div>
                <p className="inspector-copy">基于已处理文件数和最近一次批次耗时做近似估算。</p>
              </InspectorBlock>

              <InspectorBlock title="最近提醒">
                <p className="inspector-copy">
                  {props.progress.skippedCount > 0
                    ? `当前跳过数量为 ${props.progress.skippedCount}。`
                    : "当前批次没有跳过相关提醒。"}
                </p>
              </InspectorBlock>

              <InspectorBlock title="最近失败">
                <p className="inspector-copy">
                  {props.latestFailure
                    ? props.latestFailure.errorMessage ?? basename(props.latestFailure.sourceUrl)
                    : "当前会话中还没有记录到转换错误。"}
                </p>
              </InspectorBlock>
            </>
          ) : null}

          {props.activeView === "results" ? (
            <>
              <InspectorBlock title="已选记录">
                {props.selectedItem ? (
                  <>
                    <StatusBadge label={itemStateLabel(props.selectedItem.state)} variant={itemVariant(props.selectedItem.state)} />
                    <p className="inspector-copy">{basename(props.selectedItem.sourceUrl)}</p>
                    <PathCode value={props.selectedItem.outputUrl} />
                  </>
                ) : (
                  <p className="inspector-copy">选择一条结果记录后，这里会展示它的输出路径和状态。</p>
                )}
              </InspectorBlock>

              <InspectorBlock title="执行信息">
                <InspectorStat label="耗时" value={formatDuration(props.lastRunResult?.summary.durationSeconds)} />
                <InspectorStat label="目标目录" value={props.destinationPath ? basename(props.destinationPath) : "未设置"} />
                <InspectorStat label="成功记录" value={`${props.lastRunResult?.summary.converted ?? 0}`} />
              </InspectorBlock>
            </>
          ) : null}

          {props.activeView === "settings" ? (
            <>
              <InspectorBlock title="运行上下文">
                <p className="inspector-copy">可执行文件路径</p>
                <PathCode value={props.runtimeStatus?.executablePath ?? "可执行文件路径不可用"} />
              </InspectorBlock>

              <InspectorBlock title="最近错误">
                <p className="inspector-copy">{props.runtimeStatus?.lastError ?? "当前没有记录到运行时错误。"}</p>
              </InspectorBlock>

              <InspectorBlock title="更新策略">
                <p className="inspector-copy">
                  {props.runtimeStatus?.supportsInAppUpdate
                    ? "仅当运行时来源属于应用自身时，才允许在应用内直接更新。"
                    : "当前来源只能在这里查看，更新需要在应用外完成。"}
                </p>
              </InspectorBlock>
            </>
          ) : null}
        </div>
      </ScrollArea>
    </aside>
  );
}

function MetricTile(props: { label: string; value: string; detail: string }) {
  return (
    <div className="metric-tile">
      <p className="metric-tile__label">{props.label}</p>
      <div className="metric-tile__value">{props.value}</div>
      <p className="metric-tile__detail">{props.detail}</p>
    </div>
  );
}

function InfoPanel(props: { label: string; value: string; detail: string }) {
  return (
    <div className="info-panel">
      <p className="info-panel__label">{props.label}</p>
      <div className="info-panel__value">{props.value}</div>
      <p className="info-panel__detail">{props.detail}</p>
    </div>
  );
}

function InspectorBlock(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="inspector-block">
      <h3 className="inspector-block__title">{props.title}</h3>
      <div className="inspector-block__body">{props.children}</div>
    </section>
  );
}

function InspectorStat(props: { label: string; value: string }) {
  return (
    <div className="inspector-stat">
      <span>{props.label}</span>
      <span>{props.value}</span>
    </div>
  );
}

function ResolutionRow(props: { label: string; description: string; active: boolean }) {
  return (
    <div className="resolution-row">
      <div className="resolution-row__copy">
        <div className="resolution-row__title">{props.label}</div>
        <p className="resolution-row__detail">{props.description}</p>
      </div>
      <StatusBadge label={props.active ? "当前使用" : "候选来源"} variant={props.active ? "secondary" : "outline"} />
    </div>
  );
}

function StatusBadge(props: { label: string; variant: "default" | "secondary" | "outline" | "destructive" }) {
  return <Badge variant={props.variant}>{props.label}</Badge>;
}

function PathCode(props: { value: string }) {
  return (
    <code className="path-code">
      {props.value}
    </code>
  );
}

function viewContent(view: ActiveView) {
  switch (view) {
    case "execution":
      return {
        title: "批量执行",
        description: "跟踪当前队列，查看最近活动，并在文件粒度上持续观察转换进度。",
      };
    case "results":
      return {
        title: "结果与历史",
        description: "筛选当前记录，查看输出路径，并在同一工作区内直接回看失败项。",
      };
    case "settings":
      return {
        title: "运行时设置",
        description: "查看 MarkItDown 的运行时来源、可执行状态，以及应用内维护能力。",
      };
    default:
      return {
        title: "转换工作台",
        description: "在一个聚焦的工作区中准备源与目标、确认运行时状态，并发起新的批量转换。",
      };
  }
}

function inspectorTitle(view: ActiveView) {
  switch (view) {
    case "execution":
      return "实时诊断";
    case "results":
      return "已选记录";
    case "settings":
      return "运行上下文";
    default:
      return "当前批次";
  }
}

function navBadgeLabel(
  view: ActiveView,
  progressPercent: number,
  itemCount: number,
  runtimeStatus: RuntimeStatus | null,
) {
  switch (view) {
    case "execution":
      return `${progressPercent}%`;
    case "results":
      return `${itemCount}`;
    case "settings":
      return runtimeStatus?.installedVersion ?? "-";
    default:
      return runtimeStatus?.isReady ? "就绪" : "待配置";
  }
}

function navBadgeVariant(
  view: ActiveView,
  runtimeStatus: RuntimeStatus | null,
  items: ConversionItem[],
): "default" | "secondary" | "outline" | "destructive" {
  if (view === "settings") {
    if (runtimeStatus?.hasUpdateAvailable) {
      return "outline";
    }
    return runtimeStatus?.isReady ? "secondary" : "destructive";
  }

  if (view === "results") {
    return items.some((item) => item.state === "failed") ? "destructive" : "outline";
  }

  if (view === "execution") {
    return items.length > 0 ? "secondary" : "outline";
  }

  return runtimeStatus?.isReady ? "secondary" : "outline";
}

function runtimeSourceLabel(source?: RuntimeSource | null) {
  switch (source) {
    case "codex_shared":
      return "Codex 共享运行时";
    case "system_existing":
      return "系统现有运行时";
    case "app_managed":
      return "应用私有运行时";
    default:
      return "未发现运行时";
  }
}

function sourceKindLabel(kind: SourceKind) {
  return kind === "directory" ? "文件夹模式" : "单文件模式";
}

function runtimeHeader(status: RuntimeStatus | null) {
  if (!status?.isReady) {
    return "未检测到运行时";
  }
  if (status.installedVersion) {
    return `${runtimeSourceLabel(status.runtimeSource)} · ${status.installedVersion}`;
  }
  return runtimeSourceLabel(status.runtimeSource);
}

function runtimeDetail(status: RuntimeStatus | null) {
  if (!status?.isReady) {
    return "应用本体保持轻量，只有在没有可复用运行时时，才会按需准备私有运行时。";
  }

  if (status.hasUpdateAvailable && status.installedVersion && status.latestVersion) {
    return `检测到新稳定版：${status.installedVersion} -> ${status.latestVersion}`;
  }

  switch (status.runtimeSource) {
    case "codex_shared":
      return "当前批次正在复用 Codex 已提供的共享运行时。";
    case "system_existing":
      return "系统中已经存在可用的 markitdown 可执行文件，当前直接复用。";
    case "app_managed":
      return "当前运行时托管在应用支持目录中，可以在应用内直接更新。";
    default:
      return "第一次启动转换批次时，应用会自动解析并准备运行时。";
  }
}

function runBadgeVariant(
  isConverting: boolean,
  hasHistory: boolean,
  failedCount: number,
): "default" | "secondary" | "outline" | "destructive" {
  if (isConverting) {
    return "default";
  }
  if (failedCount > 0) {
    return "destructive";
  }
  if (hasHistory) {
    return "secondary";
  }
  return "outline";
}

function runStateLabel(isConverting: boolean, hasHistory: boolean, failedCount: number) {
  if (isConverting) {
    return "执行中";
  }
  if (failedCount > 0) {
    return "需要关注";
  }
  if (hasHistory) {
    return "已完成";
  }
  return "待开始";
}

function progressDescription(progress: ConversionProgress) {
  if (progress.totalCount === 0) {
    return "等待扫描待处理文件。";
  }
  return `已完成 ${progress.processedCount} / ${progress.totalCount} · 成功 ${progress.convertedCount} · 失败 ${progress.failedCount} · 跳过 ${progress.skippedCount}`;
}

function basename(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function itemStateLabel(state: ConversionItem["state"]) {
  switch (state) {
    case "converted":
      return "已完成";
    case "skipped":
      return "已跳过";
    case "failed":
      return "失败";
    case "converting":
      return "转换中";
    default:
      return "等待中";
  }
}

function itemVariant(state: ConversionItem["state"]): "default" | "secondary" | "outline" | "destructive" {
  switch (state) {
    case "converted":
      return "secondary";
    case "skipped":
      return "outline";
    case "failed":
      return "destructive";
    default:
      return "default";
  }
}

function itemSnapshot(item: ConversionItem) {
  switch (item.state) {
    case "converted":
      return "Markdown 已写入目标目录。";
    case "skipped":
      return item.errorMessage ?? "该文件已跳过。";
    case "failed":
      return item.errorMessage ?? "该文件转换失败。";
    case "converting":
      return "该文件仍在转换中。";
    default:
      return "该文件尚未开始处理。";
  }
}

function stringifyError(error: unknown) {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "toString" in error) {
    return error.toString();
  }
  return "未知错误";
}

function findLatestFailure(items: ConversionItem[]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].state === "failed") {
      return items[index];
    }
  }
  return null;
}

function itemKey(item: ConversionItem) {
  return `${item.sourceUrl}::${item.outputUrl}`;
}

function filterItems(items: ConversionItem[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return items;
  }

  return items.filter((item) => {
    const searchable = [
      item.sourceUrl,
      item.outputUrl,
      item.errorMessage ?? "",
      item.state,
    ].join(" ").toLowerCase();

    return searchable.includes(normalized);
  });
}

type QueueEntry = {
  id: string;
  title: string;
  detail: string;
  stateLabel: string;
  badgeVariant: "default" | "secondary" | "outline" | "destructive";
};

function buildQueueEntries(
  progress: ConversionProgress,
  items: ConversionItem[],
  activityMessage: string,
): QueueEntry[] {
  if (items.length > 0) {
    return items.slice(-8).reverse().map((item) => ({
      id: itemKey(item),
      title: basename(item.sourceUrl),
      detail: item.errorMessage ?? itemSnapshot(item),
      stateLabel: itemStateLabel(item.state),
      badgeVariant: itemVariant(item.state),
    }));
  }

  if (progress.currentFile) {
    return [{
      id: progress.currentFile,
      title: basename(progress.currentFile),
      detail: activityMessage,
      stateLabel: "转换中",
      badgeVariant: "default",
    }];
  }

  if (progress.totalCount > 0) {
    return [{
      id: "batch-progress",
      title: "批次队列",
      detail: progressDescription(progress),
      stateLabel: "等待中",
      badgeVariant: "outline",
    }];
  }

  return [];
}

function formatExecutionRate(
  progress: ConversionProgress,
  runStartedAt: number | null,
  isConverting: boolean,
  lastRunResult: ConversionRunResult | null,
) {
  if (isConverting && runStartedAt && progress.processedCount > 0) {
    const elapsedMinutes = Math.max((Date.now() - runStartedAt) / 60000, 1 / 60);
    return `${Math.max(1, Math.round(progress.processedCount / elapsedMinutes))} 文件/分钟`;
  }

  if (lastRunResult?.summary.durationSeconds && lastRunResult.summary.converted > 0) {
    const elapsedMinutes = Math.max(lastRunResult.summary.durationSeconds / 60, 1 / 60);
    return `${Math.max(1, Math.round(lastRunResult.summary.converted / elapsedMinutes))} 文件/分钟`;
  }

  return "0 文件/分钟";
}

function formatDuration(seconds?: number | null) {
  if (!seconds || seconds <= 0) {
    return "-";
  }

  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  return `${(seconds / 60).toFixed(1)}m`;
}

export default App;
