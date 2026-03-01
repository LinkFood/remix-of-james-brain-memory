import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useSandboxLayout } from '@/hooks/useSandboxLayout';
import WidgetGrid from '@/components/sandbox/WidgetGrid';
import SandboxHeader from '@/components/sandbox/SandboxHeader';
import CompactDumpInput from '@/components/sandbox/CompactDumpInput';
import WidgetExpandedView from '@/components/sandbox/WidgetExpandedView';

const Dashboard = () => {
  const navigate = useNavigate();
  const [userId, setUserId] = useState<string>('');
  const [expandedWidgetId, setExpandedWidgetId] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user) {
        navigate('/auth');
        return;
      }
      setUserId(session.user.id);
    });
  }, [navigate]);

  const {
    layout, onLayoutChange, removeWidget, toggleWidget, resetLayout,
    presets, loadPreset, saveCurrentAsPreset, deletePreset,
  } = useSandboxLayout();

  const activeTypeIds = useMemo(
    () => new Set(Object.values(layout.typeMap)),
    [layout.typeMap]
  );

  if (!userId) return null;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <SandboxHeader
        activeTypeIds={activeTypeIds}
        onToggleWidget={toggleWidget}
        onResetLayout={resetLayout}
        presets={presets}
        onLoadPreset={loadPreset}
        onSavePreset={saveCurrentAsPreset}
        onDeletePreset={deletePreset}
      />
      <CompactDumpInput userId={userId} />
      <div className="flex-1 overflow-auto">
        <WidgetGrid
          layout={layout}
          onLayoutChange={onLayoutChange}
          onRemoveWidget={removeWidget}
          onExpandWidget={setExpandedWidgetId}
        />
      </div>

      <WidgetExpandedView
        widgetId={expandedWidgetId}
        onClose={() => setExpandedWidgetId(null)}
      />
    </div>
  );
};

export default Dashboard;
