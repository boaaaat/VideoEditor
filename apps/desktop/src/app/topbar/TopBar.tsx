import { Download, FolderPlus, Import, Redo2, Save, Search, Settings, Undo2 } from "lucide-react";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { importMediaFiles } from "../../features/media/importMedia";

interface TopBarProps {
  projectName: string;
  onImportComplete: (message: string) => void;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
  onExport: () => void;
}

export function TopBar({ projectName, onImportComplete, onOpenCommandPalette, onOpenSettings, onExport }: TopBarProps) {
  async function handleImport() {
    const result = await importMediaFiles();
    if (!result) {
      return;
    }

    onImportComplete(result.ok ? `Import command accepted: ${result.commandId}` : result.error ?? "Import failed");
  }

  return (
    <header className="top-bar">
      <div className="project-title">
        <FolderPlus size={18} />
        <span>{projectName}</span>
      </div>
      <div className="top-actions">
        <Button icon={<Import size={16} />} onClick={handleImport}>
          Import
        </Button>
        <IconButton label="Save" icon={<Save size={17} />} />
        <IconButton label="Undo" icon={<Undo2 size={17} />} />
        <IconButton label="Redo" icon={<Redo2 size={17} />} />
        <Button icon={<Download size={16} />} variant="primary" onClick={onExport}>
          Export
        </Button>
        <IconButton label="Command search" icon={<Search size={17} />} onClick={onOpenCommandPalette} />
        <IconButton label="Settings" icon={<Settings size={17} />} onClick={onOpenSettings} />
      </div>
    </header>
  );
}
