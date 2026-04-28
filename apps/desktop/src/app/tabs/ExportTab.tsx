import { useEffect, useMemo, useState } from "react";
import { Ban, Download, FolderOpen, RefreshCw } from "lucide-react";
import type { ExportCodec, ExportContainer, ExportQuality, ExportStatus, GpuStatus, MediaMetadata, ProjectSettings } from "@ai-video-editor/protocol";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { Toggle } from "../../components/Toggle";
import { engineRpc } from "../../features/commands/commandClient";
import {
  calculateAutoBitrate,
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

interface ExportTabProps {
  projectSettings: ProjectSettings;
  onProjectSettingsChange: (settings: ProjectSettings) => void;
  firstMediaMetadata?: MediaMetadata;
  mediaAssets: MediaAsset[];
  gpuStatus: GpuStatus | null;
  setStatusMessage: (message: string) => void;
}

export function ExportTab({ projectSettings, onProjectSettingsChange, firstMediaMetadata, mediaAssets, gpuStatus, setStatusMessage }: ExportTabProps) {
  const [codec, setCodec] = useState<ExportCodec>(projectSettings.defaultCodec);
  const [container, setContainer] = useState<ExportContainer>(projectSettings.defaultContainer);
  const [quality, setQuality] = useState<ExportQuality>("medium");
  const [audioEnabled, setAudioEnabled] = useState(projectSettings.audioEnabled);
  const [outputPath, setOutputPath] = useState("");
  const [exportStatus, setExportStatus] = useState<ExportStatus>({ jobId: null, state: "idle", progress: 0, logs: [] });

  const bitrateMbps = useMemo(() => calculateAutoBitrate(projectSettings, quality, codec), [codec, projectSettings, quality]);
  const hasAudio = mediaAssets.some((asset) => asset.kind === "audio" || asset.metadata?.hasAudio);
  const validationErrors = validateExportSettings({
    outputPath,
    codec,
    container,
    colorMode: projectSettings.colorMode,
    audioEnabled,
    hasAudio,
    width: projectSettings.width,
    height: projectSettings.height,
    gpu: gpuStatus
  });
  const av1Supported = Boolean(gpuStatus?.av1NvencAvailable);

  useEffect(() => {
    setCodec((current) => (current === "av1_nvenc" && !av1Supported ? projectSettings.defaultCodec : current));
  }, [av1Supported, projectSettings.defaultCodec]);

  useEffect(() => {
    setCodec(projectSettings.defaultCodec);
    setContainer(projectSettings.defaultContainer);
    setAudioEnabled(projectSettings.audioEnabled);
  }, [projectSettings.audioEnabled, projectSettings.defaultCodec, projectSettings.defaultContainer]);

  useEffect(() => {
    if (exportStatus.state !== "running") {
      return;
    }

    const interval = window.setInterval(() => {
      void engineRpc<ExportStatus>("export.status").then(setExportStatus).catch((error) => {
        setExportStatus((current) => ({
          ...current,
          state: "error",
          logs: [...current.logs, error instanceof Error ? error.message : "Export status failed"]
        }));
      });
    }, 1200);

    return () => window.clearInterval(interval);
  }, [exportStatus.state]);

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

  function resetProjectSettings() {
    onProjectSettingsChange(firstMediaMetadata ? seedProjectSettingsFromMetadata(firstMediaMetadata) : defaultProjectSettings);
    setStatusMessage(firstMediaMetadata ? "Project settings reset to first media" : "Project settings reset");
  }

  async function chooseOutputPath() {
    const output = await pickExportOutputPath(container);
    if (output) {
      setOutputPath(output);
    }
  }

  async function exportTimeline() {
    if (validationErrors.length > 0) {
      setExportStatus((current) => ({ ...current, state: "error", logs: validationErrors }));
      setStatusMessage(validationErrors[0] ?? "Export validation failed");
      return;
    }

    const status = await engineRpc<ExportStatus>("export.start", {
      outputPath,
      resolution: projectSettings.resolution,
      width: projectSettings.width,
      height: projectSettings.height,
      fps: projectSettings.fps,
      codec,
      container,
      quality,
      bitrateMbps,
      audioEnabled,
      colorMode: projectSettings.colorMode
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "Export failed";
      const failed: ExportStatus = { jobId: null, state: "error", progress: 0, logs: [message] };
      return failed;
    });

    setExportStatus(status);
    setStatusMessage(status.state === "error" ? status.logs.at(-1) ?? "Export failed" : "Export started");
  }

  async function cancelExport() {
    const status = await engineRpc<ExportStatus>("export.cancel").catch((error) => ({
      ...exportStatus,
      state: "error" as const,
      logs: [...exportStatus.logs, error instanceof Error ? error.message : "Cancel failed"]
    }));
    setExportStatus(status);
    setStatusMessage(status.state === "cancelled" ? "Export cancelled" : "Cancel command sent");
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
            Medium bitrate
            <input value={`${projectSettings.bitrateMbps} Mbps`} readOnly />
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
            File type
            <select value={container} onChange={(event) => setContainer(event.target.value as ExportContainer)}>
              {exportContainers.map((value) => (
                <option key={value} value={value}>{value.toUpperCase()}</option>
              ))}
            </select>
          </label>
          <label>
            Codec
            <select value={codec} onChange={(event) => setCodec(event.target.value as ExportCodec)}>
              {exportCodecs.map((value) => (
                <option key={value} value={value} disabled={value === "av1_nvenc" && !av1Supported}>
                  {exportCodecLabels[value]}{value === "av1_nvenc" && !av1Supported ? " unsupported on this GPU" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Quality
            <select value={quality} onChange={(event) => setQuality(event.target.value as ExportQuality)}>
              {exportQualities.map((value) => (
                <option key={value} value={value}>{exportQualityLabels[value]}</option>
              ))}
            </select>
          </label>
          <label>
            Auto bitrate
            <input value={`${bitrateMbps} Mbps`} readOnly />
          </label>
          <label className="form-grid-wide">
            Output path
            <span className="output-picker-row">
              <input value={outputPath} onChange={(event) => setOutputPath(event.target.value)} placeholder={`Choose .${container} output`} />
              <Button icon={<FolderOpen size={16} />} onClick={chooseOutputPath}>
                Browse
              </Button>
            </span>
          </label>
          <Toggle label="Export audio" checked={audioEnabled} onChange={(event) => setAudioEnabled(event.target.checked)} />
        </div>
        {!av1Supported ? <p className="form-warning">AV1 NVENC unsupported on this GPU.</p> : null}
        {validationErrors.length > 0 ? <p className="form-warning">{validationErrors[0]}</p> : null}
        <div className="export-actions">
          <Button icon={<Download size={16} />} variant="primary" onClick={exportTimeline}>
            Export
          </Button>
          <Button icon={<Ban size={16} />} onClick={cancelExport}>
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
