import type { EditorCommand } from "./commands";

export type AiProposalStatus = "pending" | "applied" | "rejected";

export interface AiEditProposal {
  id: string;
  goal: string;
  status: AiProposalStatus;
  explanation: string;
  commands: EditorCommand[];
  createdAt: string;
}
