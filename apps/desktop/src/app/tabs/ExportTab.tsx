import { useEffect, useMemo, useRef, useState } from "react";
import { Ban, Download, FolderOpen, RefreshCw, SlidersHorizontal } from "lucide-react";
import type { ExportCodec, ExportContainer, ExportEncoderOptions, ExportQuality, ExportStatus, GpuStatus, MediaMetadata, ProjectSettings, Timeline } from "@ai-video-editor/protocol";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { Toggle } from "../../components/Toggle";
import { NumberField } from "../../components/NumberField";
import { engineRpc } from "../../features/commands/commandClient";
import type { LogStatus } from "../../features/logging/appLog";
import {
  calculateAutoBitrate,
  exportDestinationExists,
  exportCodecLabels,
  exportCodecs,
  exportContainers,
  exportFpsOptions,
  exportQualities,
  exportQualityLabels,
  exportResolutions,
  pickExportOutputPath,
  validateExportSettings
} from "../../features/export";
import { defaultProjectSettings, seedProjectSettingsFromMetadata } from "../../features/settings";
import type { MediaAsset } from "../../features/media/mediaTypes";

type ExportPresetId = "quality_tier" | "custom" | "web_1080p" | "archive_4k" | "preview_fast";

const exportPresetLabels: Record<ExportPresetId, string> = {
  quality_tier: "Quality tier",
  custom: "Custom encoder",
  web_1080p: "Web 1080p",
  archive_4k: "Archive 4K",
  preview_fast: "Compact Preview"
};

interface RenderPagePreferences {
  preset: ExportPresetId;
  codec: ExportCodec;
  container: ExportContainer;
  quality: ExportQuality;
  audioEnabled: boolean;
  outputPath: string;
  encoderOptions: ExportEncoderOptions;
}

const renderPreferencesStorageKey = "ai-video-editor.render-preferences.v1";
const defaultEncoderOptions: ExportEncoderOptions = {
  enabled: true,
  preset: "p5",
  tune: "hq",
  cq: 28,
  maxBitrateMbps: 14,
  lookaheadDepth: 16,
  lookaheadLevel: 0,
  multipass: "qres",
  spatialAq: true,
  temporalAq: true,
  aqStrength: 8,
  bFrames: 3,
  bRefMode: "middle",
  referenceFrames: 4,
  highBitDepth: true,
  splitEncodeMode: "disabled"
};

interface ExportTabProps {
  projectSettings: ProjectSettings;
  onProjectSettingsChange: (settings: ProjectSettings) => void;
  firstMediaMetadata?: MediaMetadata;
  mediaAssets: MediaAsset[];
  timeline: Timeline;
  timelineDurationUs: number;
  gpuStatus: GpuStatus | null;
  setStatusMessage: LogStatus;
}

export function ExportTab({ projectSettings, onProjectSettingsChange, firstMediaMetadata, mediaAssets, timeline, timelineDurationUs, gpuStatus, setStatusMessage }: ExportTabProps) {
  const savedPreferencesRef = useRef(loadRenderPagePreferences());
  const savedPreferences = savedPreferencesRef.current;
  const [codec, setCodec] = useState<ExportCodec>(savedPreferences?.codec ?? projectSettings.defaultCodec);
  const [container, setContainer] = useState<ExportContainer>(savedPreferences?.container ?? projectSettings.defaultContainer);
  const [quality, setQuality] = useState<ExportQuality>(savedPreferences?.quality ?? "medium");
  const [audioEnabled, setAudioEnabled] = useState(savedPreferences?.audioEnabled ?? projectSettings.audioEnabled);
  const [preset, setPreset] = useState<ExportPresetId>(savedPreferences?.preset ?? "quality_tier");
  const [outputPath, setOutputPath] = useState(savedPreferences?.outputPath ?? "");
  const [encoderOptions, setEncoderOptions] = useState<ExportEncoderOptions>(
    savedPreferences?.encoderOptions ?? encoderOptionsForProfile(codec, quality, projectSettings)
  );
  const [exportStatus, setExportStatus] = useState<ExportStatus>({ jobId: null, state: "idle", progress: 0, logs: [] });
  const loggedExportLinesRef = useRef(0);
  const loggedJobIdRef = useRef<string | null>(null);
  const statusMessageRef = useRef(setStatusMessage);
  statusMessageRef.current = setStatusMessage;
  const [rangeEnabled, setRangeEnabled] = useState(false);
  const [rangeStartUs, setRangeStartUs] = useState(0);
  const [rangeEndUs, setRangeEndUs] = useState<number | null>(null);

  const bitrateMbps = useMemo(() => calculateAutoBitrate(projectSettings, quality, codec), [codec, projectSettings, quality]);
  const peakBitrateMbps = preset === "custom"
    ? encoderOptions.maxBitrateMbps
    : Math.ceil(bitrateMbps * peakBitrateMultiplier(quality));
  const hasAudio = mediaAssets.some((asset) => asset.kind === "audio" || asset.metadata?.hasAudio);
  const fullDurationUs = useMemo(() => getVisibleVideoDurationUs(timeline, mediaAssets), [mediaAssets, timeline]);
  const effectiveRangeEndUs = rangeEndUs ?? fullDurationUs;
  const exportDurationUs = rangeEnabled ? effectiveRangeEndUs - rangeStartUs : fullDurationUs;
  const validationErrors = validateExportSettings({
    outputPath,
    codec,
    container,
    colorMode: projectSettings.colorMode,
    audioEnabled,
    hasAudio,
    width: projectSettings.width,
    height: projectSettings.height,
    durationUs: exportDurationUs,
    gpu: gpuStatus
  });
  const av1Supported = Boolean(gpuStatus?.av1NvencAvailable);
  if (rangeEnabled && (rangeStartUs < 0 || effectiveRangeEndUs > fullDurationUs || effectiveRangeEndUs <= rangeStartUs)) validationErrors.push("Set a range within the sequence, with the end after the start.");
  if (!("__TAURI_INTERNALS__" in window)) validationErrors.push("Open the desktop app to render an output file.");
  const exportRunning = exportStatus.state === "running";
  const manualLookaheadAvailable = codec === "h264_nvenc" || encoderOptions.tune !== "uhq";
  const manualBFramesAvailable = codec !== "av1_nvenc" || (manualLookaheadAvailable && encoderOptions.lookaheadDepth === 0 && encoderOptions.multipass === "disabled");

  useEffect(() => {
    setCodec((current) => (current === "av1_nvenc" && !av1Supported ? projectSettings.defaultCodec : current));
  }, [av1Supported, projectSettings.defaultCodec]);

  useEffect(() => {
    saveRenderPagePreferences({ preset, codec, container, quality, audioEnabled, outputPath, encoderOptions });
  }, [audioEnabled, codec, container, encoderOptions, outputPath, preset, quality]);

  useEffect(() => {
    let disposed = false;
    let reportedFailure = false;
    let timeout: number;
    async function poll() {
      try {
        const status = await engineRpc<ExportStatus>("export.status");
        if (!disposed) setExportStatus(status);
        reportedFailure = false;
      } catch (error) {
        if (!disposed && !reportedFailure) statusMessageRef.current(error instanceof Error ? error.message : "Export status unavailable; reconnecting", { level: "warning", source: "export" });
        reportedFailure = true;
      } finally {
        if (!disposed) timeout = window.setTimeout(poll, 500);
      }
    }
    // Include renders started by an agent or while this tab was closed.
    void poll();
    return () => { disposed = true; window.clearTimeout(timeout); };
  }, []);

  useEffect(() => {
    if (exportStatus.jobId !== loggedJobIdRef.current || exportStatus.logs.length < loggedExportLinesRef.current) {
      loggedExportLinesRef.current = 0;
      loggedJobIdRef.current = exportStatus.jobId;
    }

    const nextLogs = exportStatus.logs.slice(loggedExportLinesRef.current);
    loggedExportLinesRef.current = exportStatus.logs.length;
    for (const line of nextLogs) {
      setStatusMessage(line, {
        level: exportStatus.state === "error" ? "error" : exportStatus.state === "completed" ? "success" : "info",
        details: { jobId: exportStatus.jobId, state: exportStatus.state, progress: exportStatus.progress }
      });
    }
  }, [exportStatus.jobId, exportStatus.logs, exportStatus.progress, exportStatus.state, setStatusMessage]);

  function updateSettings(next: Partial<ProjectSettings>) {
    const merged = {
      ...projectSettings,
      ...next
    };
    onProjectSettingsChange({
      ...merged,
      bitrateMbps: calculateAutoBitrate(merged, "medium", merged.defaultCodec)
    });
  }

  function updateEncoderOptions(next: Partial<ExportEncoderOptions>) {
    setEncoderOptions((current) => ({ ...current, ...next, enabled: true }));
  }

  function saveCustomSettings() {
    saveRenderPagePreferences({ preset, codec, container, quality, audioEnabled, outputPath, encoderOptions });
    setStatusMessage("Custom render settings saved", { source: "export" });
  }

  function resetCustomSettings() {
    setEncoderOptions(encoderOptionsForProfile(codec, quality, projectSettings));
    setStatusMessage(`Custom encoder reset to ${exportQualityLabels[quality]}`, { source: "export" });
  }

  function applyExportPreset(nextPreset: ExportPresetId) {
    setPreset(nextPreset);
    if (nextPreset === "custom") {
      setEncoderOptions(encoderOptionsForProfile(codec, quality, projectSettings));
      setStatusMessage(`Custom encoder initialized from ${exportQualityLabels[quality]}`, { source: "export" });
      return;
    }
    if (nextPreset === "quality_tier") {
      return;
    }

    if (nextPreset === "web_1080p") {
      setCodec("h264_nvenc");
      setContainer("mp4");
      setQuality("medium");
      setAudioEnabled(hasAudio);
      updateSettings({ resolution: "1080p", width: 1920, height: 1080, defaultCodec: "h264_nvenc", defaultContainer: "mp4", audioEnabled: hasAudio });
      setStatusMessage("Applied Web 1080p export preset", { source: "export" });
      return;
    }

    if (nextPreset === "archive_4k") {
      const archiveCodec = av1Supported ? "av1_nvenc" : "hevc_nvenc";
      setCodec(archiveCodec);
      setContainer("mkv");
      setQuality("high");
      setAudioEnabled(hasAudio);
      updateSettings({ resolution: "4k", width: 3840, height: 2160, defaultCodec: archiveCodec, defaultContainer: "mkv", audioEnabled: hasAudio });
      setStatusMessage("Applied Archive 4K export preset", { source: "export" });
      return;
    }

    setCodec("h264_nvenc");
    setContainer("mp4");
    setQuality("low");
    setAudioEnabled(false);
    updateSettings({ resolution: "1080p", width: 1920, height: 1080, defaultCodec: "h264_nvenc", defaultContainer: "mp4", audioEnabled: false });
    setStatusMessage("Applied Compact Preview export preset", { source: "export" });
  }

  function resetProjectSettings() {
    onProjectSettingsChange(firstMediaMetadata ? seedProjectSettingsFromMetadata(firstMediaMetadata) : defaultProjectSettings);
    setStatusMessage(firstMediaMetadata ? "Project settings reset to first media" : "Project settings reset", { source: "project" });
  }

  async function chooseOutputPath() {
    const output = await pickExportOutputPath(container);
    if (output) {
      setOutputPath(output);
      setStatusMessage("Export output path selected", { details: { outputPath: output } });
    }
  }

  async function exportTimeline() {
    if (validationErrors.length > 0) {
      setExportStatus((current) => ({ ...current, state: "error", logs: validationErrors }));
      setStatusMessage(validationErrors[0] ?? "Export validation failed", { level: "warning" });
      return;
    }

    const overwrite = await exportDestinationExists(outputPath);
    if (overwrite && !window.confirm("Replace the existing export file?")) {
      setStatusMessage("Export cancelled before overwrite", { level: "warning", details: { outputPath } });
      return;
    }

    loggedExportLinesRef.current = 0;
    setExportStatus({
      jobId: null,
      outputPath,
      state: "running",
      progress: 0,
      logs: ["Export start requested"]
    });
    setStatusMessage("Export start requested", {
      source: "export",
      details: { outputPath, width: projectSettings.width, height: projectSettings.height, fps: projectSettings.fps, durationUs: exportDurationUs, editDurationUs: timelineDurationUs }
    });

    const status = await engineRpc<ExportStatus>("export.start", {
      outputPath,
      resolution: projectSettings.resolution,
      width: projectSettings.width,
      height: projectSettings.height,
      fps: projectSettings.fps,
      durationUs: exportDurationUs,
      ...(rangeEnabled ? { rangeStartUs, rangeEndUs: effectiveRangeEndUs } : {}),
      codec,
      container,
      quality,
      bitrateMbps,
      encoderOptions: preset === "custom" ? {
        ...encoderOptions,
        enabled: true,
        tune: codec === "h264_nvenc" ? "hq" : encoderOptions.tune,
        cq: Math.min(codec === "av1_nvenc" ? 63 : 51, encoderOptions.cq),
        highBitDepth: codec !== "h264_nvenc" && encoderOptions.highBitDepth,
        splitEncodeMode: codec === "h264_nvenc" ? "auto" : encoderOptions.splitEncodeMode
      } : undefined,
      audioEnabled,
      masterGainDb: projectSettings.masterGainDb ?? 0,
      normalizeAudio: projectSettings.normalizeAudio,
      cleanupAudio: projectSettings.cleanupAudio,
      colorMode: projectSettings.colorMode,
      overwrite,
      mediaAssets,
      timeline
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "Export failed";
      const failed: ExportStatus = { jobId: null, state: "error", progress: 0, logs: [message] };
      return failed;
    });

    setExportStatus(status);
    setStatusMessage(status.state === "error" ? status.logs.at(-1) ?? "Export failed" : "Export started", {
      level: status.state === "error" ? "error" : "success",
      details: { outputPath, codec, container, quality }
    });
  }

  async function cancelExport() {
    const status = await engineRpc<ExportStatus>("export.cancel").catch((error) => ({
      ...exportStatus,
      state: "error" as const,
      logs: [...exportStatus.logs, error instanceof Error ? error.message : "Cancel failed"]
    }));
    setExportStatus(status);
    setStatusMessage(status.state === "cancelled" ? "Export cancelled" : "Cancel command sent", {
      level: status.state === "cancelled" ? "warning" : "info"
    });
  }

  function updateResolution(value: ProjectSettings["resolution"]) {
    if (value === "1080p") {
      updateSettings({ resolution: value, width: 1920, height: 1080 });
      return;
    }
    if (value === "1440p") {
      updateSettings({ resolution: value, width: 2560, height: 1440 });
      return;
    }
    if (value === "4k") {
      updateSettings({ resolution: value, width: 3840, height: 2160 });
      return;
    }
    if (value === "source" && firstMediaMetadata?.width && firstMediaMetadata?.height) {
      updateSettings({ resolution: value, width: firstMediaMetadata.width, height: firstMediaMetadata.height });
      return;
    }
    updateSettings({ resolution: value });
  }

  return (
    <div className="export-grid">
      <Panel title="Project Settings">
        <div className="form-grid">
          <label>
            Resolution
            <select value={projectSettings.resolution} onChange={(event) => updateResolution(event.target.value as ProjectSettings["resolution"])}>
              {exportResolutions.map((value) => (
                <option key={value} value={value}>
                  {formatResolutionOption(value, firstMediaMetadata)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Width
            <input
              type="number"
              min={2}
              step={2}
              value={projectSettings.width}
              onChange={(event) => updateSettings({ resolution: "custom", width: normalizeEvenSize(event.target.valueAsNumber) })}
            />
          </label>
          <label>
            Height
            <input
              type="number"
              min={2}
              step={2}
              value={projectSettings.height}
              onChange={(event) => updateSettings({ resolution: "custom", height: normalizeEvenSize(event.target.valueAsNumber) })}
            />
          </label>
          <label>
            FPS
            <select value={projectSettings.fps} onChange={(event) => updateSettings({ fps: Number(event.target.value) as ProjectSettings["fps"] })}>
              {exportFpsOptions.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Color
            <select value={projectSettings.colorMode} onChange={(event) => updateSettings({ colorMode: event.target.value as ProjectSettings["colorMode"] })}>
              <option value="SDR">SDR</option>
              <option value="HDR">HDR</option>
            </select>
          </label>
          <label>
            Default codec
            <select value={projectSettings.defaultCodec} onChange={(event) => updateSettings({ defaultCodec: event.target.value as ExportCodec })}>
              {exportCodecs.map((value) => (
                <option key={value} value={value} disabled={value === "av1_nvenc" && !av1Supported}>
                  {exportCodecLabels[value]}{value === "av1_nvenc" && !av1Supported ? " unavailable" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Default file type
            <select value={projectSettings.defaultContainer} onChange={(event) => updateSettings({ defaultContainer: event.target.value as ExportContainer })}>
              {exportContainers.map((value) => (
                <option key={value} value={value}>{value.toUpperCase()}</option>
              ))}
            </select>
          </label>
          <label>
            Medium peak ceiling
            <input value={`${Math.ceil(calculateAutoBitrate(projectSettings, "medium", projectSettings.defaultCodec) * peakBitrateMultiplier("medium"))} Mbps`} readOnly />
          </label>
        </div>
        <div className="export-actions">
          <Button icon={<RefreshCw size={16} />} onClick={resetProjectSettings}>
            Reset to first media
          </Button>
        </div>
      </Panel>

      <Panel title="Export">
        <div className="form-grid">
          <label>
            Export mode
            <select value={preset} onChange={(event) => applyExportPreset(event.target.value as ExportPresetId)}>
              {(Object.keys(exportPresetLabels) as ExportPresetId[]).map((value) => (
                <option key={value} value={value}>{exportPresetLabels[value]}</option>
              ))}
            </select>
          </label>
          <label>
            File type
            <select value={container} onChange={(event) => {
              setContainer(event.target.value as ExportContainer);
            }}>
              {exportContainers.map((value) => (
                <option key={value} value={value}>{value.toUpperCase()}</option>
              ))}
            </select>
          </label>
          <label>
            Codec
            <select value={codec} onChange={(event) => {
              const nextCodec = event.target.value as ExportCodec;
              setCodec(nextCodec);
              if (preset === "custom") {
                setEncoderOptions(encoderOptionsForProfile(nextCodec, quality, projectSettings));
              } else {
                setPreset("quality_tier");
              }
            }}>
              {exportCodecs.map((value) => (
                <option key={value} value={value} disabled={value === "av1_nvenc" && !av1Supported}>
                  {exportCodecLabels[value]}{value === "av1_nvenc" && !av1Supported ? " unsupported on this GPU" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            {preset === "custom" ? "Base quality tier" : "Quality tier"}
            <select value={quality} onChange={(event) => {
              const nextQuality = event.target.value as ExportQuality;
              setQuality(nextQuality);
              if (preset === "custom") {
                setEncoderOptions(encoderOptionsForProfile(codec, nextQuality, projectSettings));
              } else {
                setPreset("quality_tier");
              }
            }}>
              {exportQualities.map((value) => (
                <option key={value} value={value}>{exportQualityLabels[value]}</option>
              ))}
            </select>
          </label>
          <label>
            Peak bitrate ceiling
            <input value={`${peakBitrateMbps} Mbps`} readOnly />
          </label>
          <label>
            Export duration
            <input value={`${formatDuration(exportDurationUs)} of ${formatDuration(fullDurationUs)} sequence`} readOnly />
          </label>
          <div className="form-grid-wide control-stack">
            <Toggle label="Export a time range" checked={rangeEnabled} onChange={(event) => setRangeEnabled(event.target.checked)} />
            {rangeEnabled ? <div className="title-field-grid">
              <NumberField label="Range start · seconds" value={rangeStartUs / 1_000_000} min={0} max={fullDurationUs / 1_000_000} step={1 / projectSettings.fps} onCommit={(value) => setRangeStartUs(Math.round(value * 1_000_000))} />
              <NumberField label="Range end · seconds" value={effectiveRangeEndUs / 1_000_000} min={0} max={fullDurationUs / 1_000_000} step={1 / projectSettings.fps} onCommit={(value) => setRangeEndUs(Math.round(value * 1_000_000))} />
            </div> : null}
          </div>
          <label className="form-grid-wide">
            Output path
            <span className="output-picker-row">
              <input value={outputPath} onChange={(event) => setOutputPath(event.target.value)} placeholder={`Choose .${container} output`} />
              <Button icon={<FolderOpen size={16} />} onClick={chooseOutputPath}>
                Browse
              </Button>
            </span>
          </label>
          <Toggle label="Export audio" checked={audioEnabled} onChange={(event) => {
            setAudioEnabled(event.target.checked);
          }} />
          <div className="form-grid-wide custom-mode-entry">
            <span>{preset === "custom" ? "Advanced encoder controls are open below." : "Need direct control over NVENC compression and quality?"}</span>
            <Button
              icon={<SlidersHorizontal size={16} />}
              variant={preset === "custom" ? "primary" : "secondary"}
              onClick={() => applyExportPreset(preset === "custom" ? "quality_tier" : "custom")}
            >
              {preset === "custom" ? "Use quality tiers" : "Open Custom Encoder"}
            </Button>
          </div>
        </div>
        {preset === "custom" ? (
          <div className="custom-export-options">
            <div className="custom-export-heading">
              <div>
                <strong>Custom encoder controls</strong>
                <span>Lower CQ means higher quality and larger files.</span>
              </div>
              <div className="export-actions">
                <Button onClick={resetCustomSettings}>Reset to {exportQualityLabels[quality]}</Button>
                <Button variant="primary" onClick={saveCustomSettings}>Save custom</Button>
              </div>
            </div>
            <div className="form-grid custom-export-grid">
              <label>
                NVENC preset
                <select value={encoderOptions.preset} onChange={(event) => updateEncoderOptions({ preset: event.target.value as ExportEncoderOptions["preset"] })}>
                  {(["p1", "p2", "p3", "p4", "p5", "p6", "p7"] as const).map((value) => (
                    <option key={value} value={value}>{value.toUpperCase()}</option>
                  ))}
                </select>
              </label>
              <label>
                Tuning
                <select value={codec === "h264_nvenc" ? "hq" : encoderOptions.tune} onChange={(event) => updateEncoderOptions({ tune: event.target.value as ExportEncoderOptions["tune"] })}>
                  <option value="hq">High quality</option>
                  <option value="uhq" disabled={codec === "h264_nvenc"}>Ultra high quality</option>
                </select>
              </label>
              <label>
                Constant quality (CQ)
                <input type="number" min={0} max={codec === "av1_nvenc" ? 63 : 51} value={encoderOptions.cq} onChange={(event) => updateEncoderOptions({ cq: clampInteger(event.target.valueAsNumber, 0, codec === "av1_nvenc" ? 63 : 51) })} />
              </label>
              <label>
                Peak bitrate (Mbps)
                <input type="number" min={1} max={2000} value={encoderOptions.maxBitrateMbps} onChange={(event) => updateEncoderOptions({ maxBitrateMbps: clampInteger(event.target.valueAsNumber, 1, 2000) })} />
              </label>
              <label>
                Lookahead frames
                <input title={manualLookaheadAvailable ? undefined : "UHQ manages lookahead internally."} type="number" min={0} max={32} value={encoderOptions.lookaheadDepth} disabled={!manualLookaheadAvailable} onChange={(event) => updateEncoderOptions({ lookaheadDepth: clampInteger(event.target.valueAsNumber, 0, 32) })} />
              </label>
              <label>
                Lookahead level
                <select title={codec === "h264_nvenc" ? "H.264 supports level 0. Lookahead frames remain adjustable." : manualLookaheadAvailable ? "Higher levels require compatible GPU hardware." : "UHQ manages lookahead level internally."} value={codec === "h264_nvenc" ? 0 : encoderOptions.lookaheadLevel} disabled={!manualLookaheadAvailable || codec === "h264_nvenc"} onChange={(event) => updateEncoderOptions({ lookaheadLevel: Number(event.target.value) as ExportEncoderOptions["lookaheadLevel"] })}>
                  {[0, 1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label>
                Multipass
                <select value={encoderOptions.multipass} onChange={(event) => updateEncoderOptions({ multipass: event.target.value as ExportEncoderOptions["multipass"] })}>
                  <option value="disabled">Disabled</option>
                  <option value="qres">Quarter resolution</option>
                  <option value="fullres">Full resolution</option>
                </select>
              </label>
              <label>
                AQ strength
                <input type="number" min={1} max={15} value={encoderOptions.aqStrength} onChange={(event) => updateEncoderOptions({ aqStrength: clampInteger(event.target.valueAsNumber, 1, 15) })} />
              </label>
              <label>
                B-frames
                <input title={manualBFramesAvailable ? undefined : "AV1 presets manage B-frames while lookahead or multipass is enabled."} type="number" min={0} max={5} value={encoderOptions.bFrames} disabled={!manualBFramesAvailable} onChange={(event) => updateEncoderOptions({ bFrames: clampInteger(event.target.valueAsNumber, 0, 5) })} />
              </label>
              <label>
                B-frame references
                <select title={manualBFramesAvailable ? undefined : "AV1 presets manage B-frame references while lookahead or multipass is enabled."} value={encoderOptions.bRefMode} disabled={!manualBFramesAvailable || encoderOptions.bFrames === 0} onChange={(event) => updateEncoderOptions({ bRefMode: event.target.value as ExportEncoderOptions["bRefMode"] })}>
                  <option value="disabled">Disabled</option>
                  <option value="middle">Middle</option>
                  <option value="each">Each</option>
                </select>
              </label>
              <label>
                Reference frames
                <input title={manualBFramesAvailable ? undefined : "AV1 presets manage reference frames while lookahead or multipass is enabled."} type="number" min={1} max={16} value={encoderOptions.referenceFrames} disabled={!manualBFramesAvailable} onChange={(event) => updateEncoderOptions({ referenceFrames: clampInteger(event.target.valueAsNumber, 1, 16) })} />
              </label>
              <label>
                Split encoding
                <select value={codec === "h264_nvenc" ? "auto" : encoderOptions.splitEncodeMode} disabled={codec === "h264_nvenc"} onChange={(event) => updateEncoderOptions({ splitEncodeMode: event.target.value as ExportEncoderOptions["splitEncodeMode"] })}>
                  <option value="auto">Automatic</option>
                  <option value="disabled">Disabled (best compression)</option>
                </select>
              </label>
              <Toggle label="Spatial AQ" checked={encoderOptions.spatialAq} onChange={(event) => updateEncoderOptions({ spatialAq: event.target.checked })} />
              <Toggle label="Temporal AQ" checked={encoderOptions.temporalAq} onChange={(event) => updateEncoderOptions({ temporalAq: event.target.checked })} />
              <Toggle label="10-bit encode" checked={codec !== "h264_nvenc" && encoderOptions.highBitDepth} disabled={codec === "h264_nvenc"} onChange={(event) => updateEncoderOptions({ highBitDepth: event.target.checked })} />
            </div>
          </div>
        ) : null}
        {!av1Supported ? <p className="form-warning">AV1 NVENC unsupported on this GPU.</p> : null}
        {validationErrors.length > 0 ? <p className="form-warning">{validationErrors[0]}</p> : null}
        <div className="export-actions">
          <Button icon={<Download size={16} />} variant="primary" onClick={exportTimeline} disabled={exportRunning}>
            Export
          </Button>
          <Button icon={<Ban size={16} />} onClick={cancelExport} disabled={!exportRunning}>
            Cancel
          </Button>
        </div>
      </Panel>

      <Panel title="Progress" className="export-progress-panel">
        <div className="progress-shell">
          <span style={{ width: `${Math.round((exportStatus.progress ?? 0) * 100)}%` }} />
        </div>
        <div className="export-status-line">
          <span>{exportStatus.state}</span>
          <span>{Math.round((exportStatus.progress ?? 0) * 100)}%</span>
        </div>
        {exportRunning || exportStatus.state === "completed" ? (
          <div className="export-status-line">
            <span>{exportStatus.speed && exportStatus.speed > 0 ? `${exportStatus.speed.toFixed(2)}x` : "Initializing render…"}</span>
            <span>
              {exportStatus.encodingFps && exportStatus.encodingFps > 0 ? `${Math.round(exportStatus.encodingFps)} fps` : ""}
              {exportRunning && exportStatus.etaSeconds && exportStatus.etaSeconds > 0 ? ` · ${formatStatusDuration(exportStatus.etaSeconds)} remaining` : ""}
            </span>
          </div>
        ) : null}
        <pre className="log-view">{exportStatus.logs.length > 0 ? exportStatus.logs.join("\n") : "Export logs will appear here."}</pre>
      </Panel>
    </div>
  );
}

function formatResolutionOption(value: ProjectSettings["resolution"], metadata?: MediaMetadata) {
  if (value === "source") {
    return metadata?.width && metadata?.height ? `Source (${metadata.width}x${metadata.height})` : "Source";
  }
  if (value === "custom") {
    return "Custom";
  }
  if (value === "4k") {
    return "4K (3840x2160)";
  }
  if (value === "1440p") {
    return "1440p (2560x1440)";
  }
  return "1080p (1920x1080)";
}

function normalizeEvenSize(value: number) {
  if (!Number.isFinite(value)) {
    return 2;
  }

  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function clampInteger(value: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min;
}

function peakBitrateMultiplier(quality: ExportQuality) {
  if (quality === "trash") {
    return 1;
  }
  if (quality === "low") {
    return 1.25;
  }
  if (quality === "medium") {
    return 1.5;
  }
  if (quality === "high") {
    return 1.75;
  }
  return 2;
}

function encoderOptionsForProfile(codec: ExportCodec, quality: ExportQuality, settings: ProjectSettings): ExportEncoderOptions {
  const profile = {
    trash: { preset: "p4", cq: { h264_nvenc: 43, hevc_nvenc: 44, av1_nvenc: 52 }, lookaheadDepth: 0, multipass: "disabled", aqStrength: 6, temporalAq: false, bFrames: 0, referenceFrames: 1 },
    low: { preset: "p5", cq: { h264_nvenc: 34, hevc_nvenc: 35, av1_nvenc: 42 }, lookaheadDepth: 12, multipass: "qres", aqStrength: 7, temporalAq: true, bFrames: 2, referenceFrames: 3 },
    medium: { preset: "p5", cq: { h264_nvenc: 28, hevc_nvenc: 28, av1_nvenc: 34 }, lookaheadDepth: 16, multipass: "qres", aqStrength: 8, temporalAq: true, bFrames: 3, referenceFrames: 4 },
    high: { preset: "p6", cq: { h264_nvenc: 23, hevc_nvenc: 23, av1_nvenc: 28 }, lookaheadDepth: 20, multipass: "qres", aqStrength: 8, temporalAq: true, bFrames: 3, referenceFrames: 4 },
    pro_max: { preset: "p7", cq: { h264_nvenc: 20, hevc_nvenc: 19, av1_nvenc: 24 }, lookaheadDepth: 24, multipass: "fullres", aqStrength: 8, temporalAq: true, bFrames: 3, referenceFrames: 4 }
  } as const;
  const selected = profile[quality];
  const baseBitrateMbps = calculateAutoBitrate(settings, quality, codec);
  return {
    enabled: true,
    preset: selected.preset,
    tune: "hq",
    cq: selected.cq[codec],
    maxBitrateMbps: Math.max(2, Math.ceil(baseBitrateMbps * peakBitrateMultiplier(quality))),
    lookaheadDepth: selected.lookaheadDepth,
    lookaheadLevel: 0,
    multipass: selected.multipass,
    spatialAq: true,
    temporalAq: selected.temporalAq,
    aqStrength: selected.aqStrength,
    bFrames: selected.bFrames,
    bRefMode: selected.bFrames > 0 ? "middle" : "disabled",
    referenceFrames: selected.referenceFrames,
    highBitDepth: codec !== "h264_nvenc" && settings.colorMode === "HDR",
    splitEncodeMode: quality === "pro_max" ? "disabled" : "auto"
  };
}

function loadRenderPagePreferences(): RenderPagePreferences | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(renderPreferencesStorageKey) ?? "null") as Partial<RenderPagePreferences> | null;
    if (!parsed) {
      return null;
    }
    const preset = parsed.preset && Object.hasOwn(exportPresetLabels, parsed.preset) ? parsed.preset : "quality_tier";
    const codec = parsed.codec && exportCodecs.includes(parsed.codec) ? parsed.codec : "h264_nvenc";
    const container = parsed.container && exportContainers.includes(parsed.container) ? parsed.container : "mp4";
    const quality = parsed.quality && exportQualities.includes(parsed.quality) ? parsed.quality : "medium";
    return {
      preset,
      codec,
      container,
      quality,
      audioEnabled: parsed.audioEnabled ?? true,
      outputPath: typeof parsed.outputPath === "string" ? parsed.outputPath : "",
      encoderOptions: normalizeEncoderOptions(parsed.encoderOptions)
    };
  } catch {
    return null;
  }
}

function normalizeEncoderOptions(value: Partial<ExportEncoderOptions> | undefined): ExportEncoderOptions {
  const presetValues: ExportEncoderOptions["preset"][] = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
  const tuneValues: ExportEncoderOptions["tune"][] = ["hq", "uhq"];
  const multipassValues: ExportEncoderOptions["multipass"][] = ["disabled", "qres", "fullres"];
  const bRefValues: ExportEncoderOptions["bRefMode"][] = ["disabled", "each", "middle"];
  const splitValues: ExportEncoderOptions["splitEncodeMode"][] = ["auto", "disabled"];
  return {
    enabled: true,
    preset: value?.preset && presetValues.includes(value.preset) ? value.preset : defaultEncoderOptions.preset,
    tune: value?.tune && tuneValues.includes(value.tune) ? value.tune : defaultEncoderOptions.tune,
    cq: clampInteger(value?.cq ?? defaultEncoderOptions.cq, 0, 63),
    maxBitrateMbps: clampInteger(value?.maxBitrateMbps ?? defaultEncoderOptions.maxBitrateMbps, 1, 2000),
    lookaheadDepth: clampInteger(value?.lookaheadDepth ?? defaultEncoderOptions.lookaheadDepth, 0, 32),
    lookaheadLevel: clampInteger(value?.lookaheadLevel ?? defaultEncoderOptions.lookaheadLevel, 0, 3) as ExportEncoderOptions["lookaheadLevel"],
    multipass: value?.multipass && multipassValues.includes(value.multipass) ? value.multipass : defaultEncoderOptions.multipass,
    spatialAq: value?.spatialAq ?? defaultEncoderOptions.spatialAq,
    temporalAq: value?.temporalAq ?? defaultEncoderOptions.temporalAq,
    aqStrength: clampInteger(value?.aqStrength ?? defaultEncoderOptions.aqStrength, 1, 15),
    bFrames: clampInteger(value?.bFrames ?? defaultEncoderOptions.bFrames, 0, 5),
    bRefMode: value?.bRefMode && bRefValues.includes(value.bRefMode) ? value.bRefMode : defaultEncoderOptions.bRefMode,
    referenceFrames: clampInteger(value?.referenceFrames ?? defaultEncoderOptions.referenceFrames, 1, 16),
    highBitDepth: value?.highBitDepth ?? defaultEncoderOptions.highBitDepth,
    splitEncodeMode: value?.splitEncodeMode && splitValues.includes(value.splitEncodeMode) ? value.splitEncodeMode : defaultEncoderOptions.splitEncodeMode
  };
}

function saveRenderPagePreferences(preferences: RenderPagePreferences) {
  try {
    localStorage.setItem(renderPreferencesStorageKey, JSON.stringify(preferences));
  } catch {
    // Persistence is best-effort when storage is unavailable.
  }
}

function getVisibleVideoDurationUs(timeline: Timeline, mediaAssets: MediaAsset[]) {
  const mediaById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
  const videoDurationUs = timeline.tracks
    .filter((track) => track.kind === "video" && track.visible)
    .flatMap((track) => track.clips)
    .reduce((durationUs, clip) => {
      const asset = mediaById.get(clip.mediaId);
      if (asset?.kind !== "video" || clip.outUs <= clip.inUs) {
        return durationUs;
      }
      const speedPercent = Number.isFinite(clip.speedPercent) ? Math.min(400, Math.max(25, clip.speedPercent ?? 100)) : 100;
      const displayDurationUs = Math.max(1, Math.round((clip.outUs - clip.inUs) / (speedPercent / 100)));
      return Math.max(durationUs, clip.startUs + displayDurationUs);
    }, Math.max(0, ...(timeline.titles ?? []).map((title) => title.startUs + title.durationUs)));
  if (videoDurationUs > 0) return videoDurationUs;
  return timeline.tracks.filter((track) => !track.muted && (track.kind === "audio" || track.visible)).flatMap((track) => track.clips).reduce((duration, clip) => {
    const asset = mediaById.get(clip.mediaId);
    if (clip.audio?.muted || !(asset?.kind === "audio" || asset?.metadata?.hasAudio)) return duration;
    return Math.max(duration, clip.startUs + Math.round((clip.outUs - clip.inUs) / ((clip.speedPercent || 100) / 100)));
  }, 0);
}

function formatDuration(durationUs: number) {
  if (!Number.isFinite(durationUs) || durationUs <= 0) {
    return "0:00";
  }

  const totalSeconds = Math.ceil(durationUs / 1_000_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatStatusDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0s";
  }
  const rounded = Math.ceil(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}
