import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./App.css";
import type {
  ConversionJob,
  ConversionItem,
  ConversionProgress,
  ConversionRunResult,
  RuntimeSource,
  RuntimeStatus,
  SourceKind,
} from "./types";

const EMPTY_PROGRESS: ConversionProgress = {
  totalCount: 0,
  processedCount: 0,
  convertedCount: 0,
  skippedCount: 0,
  failedCount: 0,
  fractionCompleted: 0,
  currentFile: null,
};

type ActiveTab = "convert" | "settings";
type PillTone = "neutral" | "accent" | "success" | "warning" | "danger";

function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("convert");
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
          setActivityMessage(`正在转换：${payload.currentFile}`);
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

  const runtimeTone = useMemo<PillTone>(() => {
    if (!runtimeStatus?.isReady) return "danger";
    if (runtimeStatus.hasUpdateAvailable) return "warning";
    return "accent";
  }, [runtimeStatus]);

  const latestItem = useMemo(() => {
    if (items.length === 0) return null;
    return items[items.length - 1];
  }, [items]);

  const latestFailure = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index].state === "failed") {
        return items[index];
      }
    }

    return null;
  }, [items]);

  const progressPercent = Math.round(progress.fractionCompleted * 100);
  const successRate = progress.totalCount > 0
    ? Math.round((progress.convertedCount / progress.totalCount) * 100)
    : 0;
  const canStart = Boolean(sourcePath && destinationPath && sourceKind) && !isConverting;
  const runTone = runStateTone(isConverting, items.length > 0, progress.failedCount);

  async function refreshRuntimeStatus(fetchLatest: boolean) {
    setIsCheckingRuntime(true);
    try {
      const status = await invoke<RuntimeStatus>("scan_runtime_status", { fetchLatest });
      setRuntimeStatus(status);
    } catch (error) {
      setActivityMessage(`运行时状态获取失败：${stringifyError(error)}`);
    } finally {
      setIsCheckingRuntime(false);
    }
  }

  async function chooseSource(mode: "file" | "directory") {
    try {
      const selected = await invoke<string | null>("pick_source", { kind: mode });
      if (!selected) return;

      setSourcePath(selected);
      setSourceKind(mode === "file" ? "file" : "directory");
    } catch (error) {
      setActivityMessage(`源路径选择失败：${stringifyError(error)}`);
    }
  }

  async function chooseDestination() {
    try {
      const selected = await invoke<string | null>("pick_destination");
      if (!selected) return;

      setDestinationPath(selected);
    } catch (error) {
      setActivityMessage(`目标目录选择失败：${stringifyError(error)}`);
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
    setProgress(EMPTY_PROGRESS);
    setActivityMessage("正在准备 MarkItDown 运行时…");
    setIsConverting(true);

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
      if (result.cancelled || cancelledRef.current) {
        setActivityMessage("转换已取消。");
      } else {
        setActivityMessage(
          `转换完成：成功 ${result.summary.converted}，失败 ${result.summary.failed}，跳过 ${result.summary.skipped}。`,
        );
      }
    } catch (error) {
      setActivityMessage(`转换失败：${stringifyError(error)}`);
    } finally {
      setIsConverting(false);
      cancelledRef.current = false;
    }
  }

  async function cancelConversion() {
    if (!isConverting) return;

    cancelledRef.current = true;
    try {
      await invoke("cancel_conversion");
      setActivityMessage("正在取消转换…");
    } catch (error) {
      setActivityMessage(`取消失败：${stringifyError(error)}`);
    }
  }

  async function openDestination() {
    if (!destinationPath) return;

    try {
      await invoke("open_destination_in_finder", { path: destinationPath });
    } catch (error) {
      setActivityMessage(`打开 Finder 失败：${stringifyError(error)}`);
    }
  }

  async function checkUpdate() {
    setIsCheckingRuntime(true);
    try {
      const status = await invoke<RuntimeStatus>("check_runtime_update");
      setRuntimeStatus(status);
    } catch (error) {
      setActivityMessage(`检查更新失败：${stringifyError(error)}`);
    } finally {
      setIsCheckingRuntime(false);
    }
  }

  async function updateRuntime() {
    if (!runtimeStatus?.supportsInAppUpdate) {
      setActivityMessage("当前运行时来源不支持应用内更新。");
      return;
    }

    setIsUpdatingRuntime(true);
    setActivityMessage("正在同步 MarkItDown 运行时…");
    try {
      const status = await invoke<RuntimeStatus>("update_runtime");
      setRuntimeStatus(status);
      setActivityMessage(status.hasUpdateAvailable ? "检测到新版本。" : "MarkItDown 已准备就绪。");
    } catch (error) {
      setActivityMessage(`运行时更新失败：${stringifyError(error)}`);
    } finally {
      setIsUpdatingRuntime(false);
    }
  }

  return (
    <main className="app-shell">
      <div className="backdrop" />

      <section className="stage panel">
        <div className="stage__intro">
          <span className="eyebrow">MARKITDOWN CONVERTER</span>
          <h1>Markdown 转换工作台</h1>
          <p>
            选择一个文件或目录，保留原始层级输出，让每个文件的转换结果和失败原因都落在同一条任务流里。
          </p>

          <div className="stage__status-strip">
            <Pill tone={runtimeTone}>{runtimeSourceLabel(runtimeStatus?.runtimeSource)}</Pill>
            {runtimeStatus?.installedVersion ? (
              <Pill tone="neutral">{runtimeStatus.installedVersion}</Pill>
            ) : null}
            <Pill tone={sourceKind ? "success" : "neutral"}>
              {sourceKind ? sourceKindLabel(sourceKind) : "未选择源路径"}
            </Pill>
            <Pill tone={destinationPath ? "accent" : "neutral"}>
              {destinationPath ? "目标目录已就绪" : "待选目标目录"}
            </Pill>
            {runtimeStatus?.hasUpdateAvailable ? <Pill tone="warning">可更新</Pill> : null}
          </div>
        </div>

        <div className="stage__command">
          <div className="tab-strip">
            <button
              className={activeTab === "convert" ? "tab-strip__button is-active" : "tab-strip__button"}
              onClick={() => setActiveTab("convert")}
              type="button"
            >
              转换
            </button>
            <button
              className={activeTab === "settings" ? "tab-strip__button is-active" : "tab-strip__button"}
              onClick={() => setActiveTab("settings")}
              type="button"
            >
              设置
            </button>
          </div>

          <div className="stage__meter">
            <span className="meter__eyebrow">当前批次</span>

            <div className="meter__headline">
              <strong>
                {progressPercent}
                <span>%</span>
              </strong>
              <Pill tone={runTone}>{runStateLabel(isConverting, items.length > 0, progress.failedCount)}</Pill>
            </div>

            <p className="meter__description">{activityMessage}</p>

            <div className="progress-track" aria-hidden="true">
              <span style={{ width: `${progressPercent}%` }} />
            </div>

            <div className="summary-strip">
              <SummaryValue label="已处理" value={`${progress.processedCount}/${progress.totalCount}`} />
              <SummaryValue label="成功率" value={`${successRate}%`} />
              <SummaryValue label="失败" value={String(progress.failedCount)} />
              <SummaryValue label="跳过" value={String(progress.skippedCount)} />
            </div>
          </div>
        </div>
      </section>

      {activeTab === "convert" ? (
        <>
          <section className="workspace-grid">
            <section className="panel section workspace-panel">
              <SectionHeader
                eyebrow="WORKSPACE"
                title="转换工作区"
                description="入口路径、目标目录和执行控制都集中在这里，适合连续批量处理。"
              />

              <div className="workspace-flow">
                <PathBlock
                  badge={sourceKind ? sourceKindLabel(sourceKind) : "未选择"}
                  badgeTone={sourceKind ? "success" : "neutral"}
                  detail={sourcePath || "支持单文件和递归目录转换。"}
                  label="源路径"
                  title={sourcePath ? basename(sourcePath) : "等待选择文件或文件夹"}
                  actions={(
                    <>
                      <button className="button button--secondary" onClick={() => chooseSource("file")} type="button">
                        选择文件
                      </button>
                      <button className="button button--secondary" onClick={() => chooseSource("directory")} type="button">
                        选择文件夹
                      </button>
                    </>
                  )}
                />

                <PathBlock
                  badge={destinationPath ? "已就绪" : "未设置"}
                  badgeTone={destinationPath ? "accent" : "neutral"}
                  detail={destinationPath || "输出会保留相对层级，并将扩展名统一改为 .md。"}
                  label="目标目录"
                  title={destinationPath ? basename(destinationPath) : "等待选择目标目录"}
                  actions={(
                    <>
                      <button className="button button--secondary" onClick={chooseDestination} type="button">
                        选择目标目录
                      </button>
                      <button
                        className="button button--ghost"
                        disabled={!destinationPath}
                        onClick={openDestination}
                        type="button"
                      >
                        打开目录
                      </button>
                    </>
                  )}
                />
              </div>

              <div className="command-bar">
                <button
                  className="button button--primary"
                  disabled={!canStart}
                  onClick={startConversion}
                  type="button"
                >
                  开始转换
                </button>
                <button
                  className="button button--secondary"
                  disabled={!isConverting}
                  onClick={cancelConversion}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="button button--ghost"
                  disabled={isCheckingRuntime}
                  onClick={() => void refreshRuntimeStatus(true)}
                  type="button"
                >
                  {isCheckingRuntime ? "刷新中…" : "刷新运行时"}
                </button>
              </div>

              <div className="inline-note">
                <span className="field-label">当前运行时可执行文件</span>
                <code>{runtimeStatus?.executablePath ?? "未发现可执行文件"}</code>
              </div>
            </section>

            <aside className="panel section inspector-panel">
              <SectionHeader
                eyebrow="INSPECTOR"
                title="实时状态"
                description="用最少的信息判断当前批次是否可运行、是否有失败项，以及运行时来自哪里。"
              />

              <dl className="data-list">
                <DataPair label="任务状态" value={runStateLabel(isConverting, items.length > 0, progress.failedCount)} />
                <DataPair label="入口类型" value={sourceKind ? sourceKindLabel(sourceKind) : "-"} />
                <DataPair
                  label="当前文件"
                  value={progress.currentFile ?? (latestItem ? basename(latestItem.sourceUrl) : "-")}
                />
                <DataPair label="运行时版本" value={runtimeStatus?.installedVersion ?? "-"} />
                <DataPair label="最新稳定版" value={runtimeStatus?.latestVersion ?? "-"} />
                <DataPair label="最近检查" value={formatLastChecked(runtimeStatus?.lastCheckedAt)} />
              </dl>

              <div className="inspector-callout">
                <span className="field-label">当前说明</span>
                <p>{runtimeDetail(runtimeStatus)}</p>
              </div>

              <div className={latestFailure ? "status-banner is-warning" : "status-banner"}>
                <span className="field-label">{latestFailure ? "最近失败" : "最近结果"}</span>

                {latestFailure ? (
                  <>
                    <strong>{basename(latestFailure.sourceUrl)}</strong>
                    <p>{latestFailure.errorMessage ?? "转换失败。"}</p>
                  </>
                ) : latestItem ? (
                  <>
                    <strong>{basename(latestItem.sourceUrl)}</strong>
                    <p>{itemSnapshot(latestItem)}</p>
                  </>
                ) : (
                  <>
                    <strong>尚未产生结果</strong>
                    <p>开始一次转换后，这里会展示最近处理过的文件状态。</p>
                  </>
                )}
              </div>
            </aside>
          </section>

          <section className="panel section results-panel">
            <div className="results-top">
              <SectionHeader
                eyebrow="RESULT STREAM"
                title="结果流"
                description="按文件记录输出路径、状态和错误，不因为单个文件失败而中断整批任务。"
              />

              <div className="results-meta">
                <SummaryValue label="总文件" value={String(progress.totalCount)} />
                <SummaryValue label="成功" value={String(progress.convertedCount)} />
                <SummaryValue label="失败" value={String(progress.failedCount)} />
              </div>
            </div>

            {items.length === 0 ? (
              <div className="empty-state">
                <h3>结果会从这里开始累积</h3>
                <p>执行一次转换后，每个文件的输出路径、状态和错误信息都会依次出现。</p>
              </div>
            ) : (
              <div className="result-stream">
                {items.map((item, index) => (
                  <article
                    className="result-row"
                    key={`${item.sourceUrl}-${item.outputUrl}`}
                    style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}
                  >
                    <div className="result-row__main">
                      <span className="result-row__label">{itemStateLabel(item.state)}</span>
                      <h3>{basename(item.sourceUrl)}</h3>
                      <p>{item.errorMessage ?? itemSnapshot(item)}</p>
                    </div>

                    <div className="result-row__meta">
                      <Pill tone={itemTone(item.state)}>{itemStateLabel(item.state)}</Pill>
                      <code>{item.outputUrl}</code>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      ) : (
        <section className="settings-grid">
          <section className="panel section settings-panel">
            <SectionHeader
              eyebrow="RUNTIME SETTINGS"
              title="运行时状态"
              description="优先复用已有环境，只有在本机找不到 markitdown 时才会在用户目录准备私有运行时。"
            />

            <dl className="data-list data-list--wide">
              <DataPair label="状态" value={runtimeStatus?.isReady ? "已就绪" : "未安装"} />
              <DataPair label="运行时来源" value={runtimeSourceLabel(runtimeStatus?.runtimeSource)} />
              <DataPair label="已安装版本" value={runtimeStatus?.installedVersion ?? "-"} />
              <DataPair label="最新稳定版" value={runtimeStatus?.latestVersion ?? "-"} />
              <DataPair label="最近检查" value={formatLastChecked(runtimeStatus?.lastCheckedAt)} />
              <DataPair label="应用内更新" value={runtimeStatus?.supportsInAppUpdate ? "支持" : "不支持"} />
            </dl>

            <div className="command-bar">
              <button
                className="button button--secondary"
                disabled={isCheckingRuntime || isUpdatingRuntime}
                onClick={checkUpdate}
                type="button"
              >
                {isCheckingRuntime ? "检查中…" : "检查更新"}
              </button>
              <button
                className="button button--primary"
                disabled={isUpdatingRuntime || !runtimeStatus?.supportsInAppUpdate}
                onClick={updateRuntime}
                type="button"
              >
                {isUpdatingRuntime
                  ? "同步中…"
                  : runtimeStatus?.isReady
                    ? runtimeStatus.hasUpdateAvailable
                      ? "更新运行时"
                      : "重新安装运行时"
                    : "安装运行时"}
              </button>
            </div>

            <div className="inline-note">
              <span className="field-label">当前可执行文件</span>
              <code>{runtimeStatus?.executablePath ?? "未发现可执行文件"}</code>
            </div>

            <div className="inline-note">
              <span className="field-label">应用私有运行时目录</span>
              <code>~/Library/Application Support/MarkItDownConverter/runtime</code>
            </div>

            {runtimeStatus?.lastError ? (
              <div className="status-banner is-danger">
                <span className="field-label">最近错误</span>
                <strong>运行时操作失败</strong>
                <p>{runtimeStatus.lastError}</p>
              </div>
            ) : null}
          </section>

          <aside className="panel section source-panel">
            <SectionHeader
              eyebrow="RESOLUTION ORDER"
              title="来源策略"
              description="转换前会按固定顺序探测可用的 markitdown，可更新来源会在这里直接同步。"
            />

            <div className="source-list">
              <RuntimeSourceRow
                active={runtimeStatus?.runtimeSource === "codex_shared"}
                description="优先复用 Codex 已安装的 markitdown-mcp，减少首次安装和重复占用。"
                label="Codex 共享运行时"
              />
              <RuntimeSourceRow
                active={runtimeStatus?.runtimeSource === "system_existing"}
                description="如果系统里已有 markitdown，可直接使用，但不由应用负责升级。"
                label="系统现有运行时"
              />
              <RuntimeSourceRow
                active={runtimeStatus?.runtimeSource === "app_managed"}
                description="当本机没有可用运行时时，应用会在用户目录按需安装自己的轻量运行时。"
                label="应用私有运行时"
              />
            </div>

            <div className="status-banner">
              <span className="field-label">当前摘要</span>
              <strong>{runtimeHeader(runtimeStatus)}</strong>
              <p>{runtimeDetail(runtimeStatus)}</p>
            </div>
          </aside>
        </section>
      )}
    </main>
  );
}

function SectionHeader(props: { eyebrow: string; title: string; description: string }) {
  return (
    <header className="section-header">
      <span className="eyebrow">{props.eyebrow}</span>
      <h2>{props.title}</h2>
      <p>{props.description}</p>
    </header>
  );
}

function PathBlock(props: {
  label: string;
  title: string;
  detail: string;
  badge: string;
  badgeTone: PillTone;
  actions: React.ReactNode;
}) {
  return (
    <section className="path-block">
      <div className="path-block__head">
        <div>
          <span className="field-label">{props.label}</span>
          <h3>{props.title}</h3>
        </div>
        <Pill tone={props.badgeTone}>{props.badge}</Pill>
      </div>

      <code className="path-block__detail">{props.detail}</code>

      <div className="path-block__actions">{props.actions}</div>
    </section>
  );
}

function SummaryValue(props: { label: string; value: string }) {
  return (
    <div className="summary-value">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function DataPair(props: { label: string; value: string }) {
  return (
    <div className="data-pair">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

function RuntimeSourceRow(props: { label: string; description: string; active: boolean }) {
  return (
    <article className={props.active ? "source-row is-active" : "source-row"}>
      <div className="source-row__header">
        <h3>{props.label}</h3>
        <Pill tone={props.active ? "accent" : "neutral"}>{props.active ? "当前使用" : "备用来源"}</Pill>
      </div>
      <p>{props.description}</p>
    </article>
  );
}

function Pill(props: { tone: PillTone; children: React.ReactNode }) {
  return <span className={`pill pill--${props.tone}`}>{props.children}</span>;
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
  return kind === "directory" ? "文件夹入口" : "单文件入口";
}

function runtimeHeader(status: RuntimeStatus | null) {
  if (!status?.isReady) return "未发现可用的 MarkItDown 运行时";
  if (status.installedVersion) return `${runtimeSourceLabel(status.runtimeSource)} · ${status.installedVersion}`;
  return runtimeSourceLabel(status.runtimeSource);
}

function runtimeDetail(status: RuntimeStatus | null) {
  if (!status?.isReady) {
    return "应用本体保持轻量，首次需要时才会把运行时安装到用户目录。";
  }

  if (status.hasUpdateAvailable && status.installedVersion && status.latestVersion) {
    return `检测到新版本：${status.installedVersion} → ${status.latestVersion}`;
  }

  switch (status.runtimeSource) {
    case "codex_shared":
      return "优先复用 Codex 已安装的 markitdown，避免首次启动时重复安装。";
    case "system_existing":
      return "当前使用系统里已有的 markitdown，可直接执行转换。";
    case "app_managed":
      return "当前使用应用私有运行时，安装和更新都落在用户目录。";
    default:
      return "首次执行转换时会自动准备运行时。";
  }
}

function runStateTone(isConverting: boolean, hasHistory: boolean, failedCount: number): PillTone {
  if (isConverting) return "accent";
  if (failedCount > 0) return "warning";
  if (hasHistory) return "success";
  return "neutral";
}

function runStateLabel(isConverting: boolean, hasHistory: boolean, failedCount: number) {
  if (isConverting) return "执行中";
  if (failedCount > 0) return "需要关注";
  if (hasHistory) return "已完成";
  return "待开始";
}

function progressDescription(progress: ConversionProgress) {
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

function itemTone(state: ConversionItem["state"]): PillTone {
  switch (state) {
    case "converted":
      return "success";
    case "skipped":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "accent";
  }
}

function itemSnapshot(item: ConversionItem) {
  switch (item.state) {
    case "converted":
      return "Markdown 已生成到目标目录。";
    case "skipped":
      return item.errorMessage ?? "该文件被跳过。";
    case "failed":
      return item.errorMessage ?? "转换失败。";
    case "converting":
      return "该文件正在转换。";
    default:
      return "该文件尚未开始处理。";
  }
}

function stringifyError(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "toString" in error) return error.toString();
  return "未知错误";
}

function formatLastChecked(value: string | null | undefined) {
  if (!value) return "未检查";
  const timestamp = Number(value);
  if (Number.isFinite(timestamp)) {
    return new Date(timestamp * 1000).toLocaleString("zh-CN");
  }
  return value;
}

export default App;
