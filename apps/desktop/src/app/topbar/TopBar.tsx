import { Download, FolderPlus, Import, Redo2, Save, Search, Settings, Undo2 } from "lucide-react";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";

interface TopBarProps {
  projectName: string;
  onImportMedia: () => Promise<void>;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
  onExport: () => void;
}

export function TopBar({ projectName, onImportMedia, onSave, onUndo, onRedo, canUndo = true, canRedo = true, onOpenCommandPalette, onOpenSettings, onExport }: TopBarProps) {
  return (
    <header className="top-bar">
      <div className="project-title">
        <FolderPlus size={18} />
        <span>{projectName}</span>
      </div>
      <div className="top-actions">
        <Button icon={<Import size={16} />} onClick={onImportMedia}>
          Import
        </Button>
        <IconButton label="Save" icon={<Save size={17} />} onClick={onSave} />
        <IconButton label="Undo" icon={<Undo2 size={17} />} onClick={onUndo} disabled={!canUndo} />
        <IconButton label="Redo" icon={<Redo2 size={17} />} onClick={onRedo} disabled={!canRedo} />
        <Button icon={<Download size={16} />} variant="primary" onClick={onExport}>
          Export
        </Button>
        <IconButton label="Command search" icon={<Search size={17} />} onClick={onOpenCommandPalette} />
        <IconButton label="Settings" icon={<Settings size={17} />} onClick={onOpenSettings} />
      </div>
    </header>
  );
}
