import { useMemo, useState } from "react";
import { Bot, CheckCheck, Film, History, ListChecks, Sparkles, X } from "lucide-react";
import type { AiEditProposal } from "@ai-video-editor/protocol";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import type { MediaAsset } from "../../features/media/mediaTypes";

interface FutureAiTabProps {
  mediaAssets: MediaAsset[];
  proposals: AiEditProposal[];
  onGenerateProposal: (goal: string, mediaIds: string[]) => Promise<void>;
  onApplyProposal: (proposalId: string) => Promise<void>;
  onRejectProposal: (proposalId: string) => Promise<void>;
}

export function FutureAiTab({ mediaAssets, proposals, onGenerateProposal, onApplyProposal, onRejectProposal }: FutureAiTabProps) {
  const videoAssets = useMemo(() => mediaAssets.filter((asset) => asset.kind === "video"), [mediaAssets]);
  const [goal, setGoal] = useState("make a 45 second YouTube intro cut");
  const [selectedMediaIds, setSelectedMediaIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const selectedIds = selectedMediaIds.length > 0 ? selectedMediaIds : videoAssets.map((asset) => asset.id);
  const pendingProposals = proposals.filter((proposal) => proposal.status === "pending");
  const pastProposals = proposals.filter((proposal) => proposal.status !== "pending");

  function toggleMedia(id: string) {
    setSelectedMediaIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  async function generateProposal() {
    setBusy(true);
    try {
      await onGenerateProposal(goal, selectedIds);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tool-grid">
      <Panel title="Rough Cut Copilot">
        <div className="control-stack">
          <label>
            Edit goal
            <input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="make a 30 second rough cut" />
          </label>
          <div className="feature-list">
            <span><ListChecks size={16} /> Produces structured timeline commands</span>
            <span><CheckCheck size={16} /> Requires approval before editing</span>
            <span><History size={16} /> Applies through the engine command path</span>
          </div>
          <Button icon={<Sparkles size={16} />} variant="primary" onClick={generateProposal} disabled={busy || selectedIds.length === 0}>
            Generate Rough Cut
          </Button>
        </div>
      </Panel>

      <Panel title="Selected Media">
        <div className="media-list">
          {videoAssets.length > 0 ? (
            videoAssets.map((asset) => {
              const selected = selectedIds.includes(asset.id);
              return (
                <button key={asset.id} type="button" className={selected ? "media-card selected" : "media-card"} onClick={() => toggleMedia(asset.id)}>
                  <span className="media-thumb-frame video loaded">
                    <Film size={18} />
                  </span>
                  <span>{asset.name}</span>
                  <small>{formatIntelligence(asset)}</small>
                </button>
              );
            })
          ) : (
            <div className="empty-state">
              <Bot size={28} />
              <span>Import video media first.</span>
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Proposal Queue">
        <div className="control-stack">
          {pendingProposals.length > 0 ? (
            pendingProposals.map((proposal) => (
              <ProposalCard key={proposal.id} proposal={proposal} onApplyProposal={onApplyProposal} onRejectProposal={onRejectProposal} />
            ))
          ) : (
            <div className="empty-state">No pending proposals.</div>
          )}
        </div>
      </Panel>

      <Panel title="History">
        <div className="control-stack">
          {pastProposals.length > 0 ? (
            pastProposals.map((proposal) => (
              <div key={proposal.id} className="status-item">
                <strong>{proposal.goal}</strong>
                <small>{proposal.status}</small>
              </div>
            ))
          ) : (
            <div className="empty-state">No applied or rejected proposals yet.</div>
          )}
        </div>
      </Panel>
    </div>
  );
}

function ProposalCard({
  proposal,
  onApplyProposal,
  onRejectProposal
}: {
  proposal: AiEditProposal;
  onApplyProposal: (proposalId: string) => Promise<void>;
  onRejectProposal: (proposalId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  async function apply() {
    setBusy(true);
    try {
      await onApplyProposal(proposal.id);
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    try {
      await onRejectProposal(proposal.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="status-item">
      <strong>{proposal.goal}</strong>
      <span className="muted-line"><Sparkles size={15} /> {proposal.explanation}</span>
      <small>{proposal.commands.length} command{proposal.commands.length === 1 ? "" : "s"} queued</small>
      <pre className="log-view">{JSON.stringify(proposal.commands, null, 2)}</pre>
      <div className="export-actions">
        <Button icon={<CheckCheck size={16} />} variant="primary" onClick={apply} disabled={busy}>
          Apply
        </Button>
        <Button icon={<X size={16} />} onClick={reject} disabled={busy}>
          Reject
        </Button>
      </div>
    </div>
  );
}

function formatIntelligence(asset: MediaAsset) {
  const summary = asset.intelligence?.summary;
  if (!summary) {
    return asset.metadata ? `${asset.metadata.width}x${asset.metadata.height} - ${Math.round(asset.metadata.fps)} fps` : "not analyzed yet";
  }

  const resolution = summary.resolution.width > 0 && summary.resolution.height > 0 ? `${summary.resolution.width}x${summary.resolution.height}` : "resolution unknown";
  const seconds = summary.durationUs > 0 ? `${Math.round(summary.durationUs / 1_000_000)}s` : "duration unknown";
  return `${resolution} - ${Math.round(summary.fps)} fps - ${seconds} - ${summary.hdr ? "HDR" : "SDR"}`;
}
