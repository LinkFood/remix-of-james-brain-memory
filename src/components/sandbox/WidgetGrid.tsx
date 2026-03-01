import { useMemo, useCallback } from 'react';
import { Responsive, useContainerWidth } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import type { Layout } from 'react-grid-layout';
import { WIDGET_MAP } from '@/lib/widget-registry';
import type { SandboxLayout } from '@/types/widget';
import WidgetChrome from './WidgetChrome';
import { useNavigate } from 'react-router-dom';

interface WidgetGridProps {
  layout: SandboxLayout;
  onLayoutChange: (layout: Layout[]) => void;
  onRemoveWidget: (instanceId: string) => void;
  onExpandWidget?: (typeId: string) => void;
}

const WidgetGrid = ({ layout, onLayoutChange, onRemoveWidget, onExpandWidget }: WidgetGridProps) => {
  const navigate = useNavigate();
  const { width, containerRef, mounted } = useContainerWidth({ initialWidth: 1200 });

  const children = useMemo(() => {
    return layout.items
      .map((item) => {
        const typeId = layout.typeMap[item.i];
        const def = WIDGET_MAP.get(typeId);
        if (!def) return null;

        const WidgetComponent = def.component;

        return (
          <div key={item.i}>
            <WidgetChrome
              definition={def}
              instanceId={item.i}
              onRemove={() => onRemoveWidget(item.i)}
              onExpand={onExpandWidget ? () => onExpandWidget(typeId) : undefined}
            >
              <WidgetComponent
                instanceId={item.i}
                compact={item.h <= 2}
                onRemove={() => onRemoveWidget(item.i)}
                onNavigate={navigate}
              />
            </WidgetChrome>
          </div>
        );
      })
      .filter(Boolean);
  }, [layout, onRemoveWidget, onExpandWidget, navigate]);

  const handleLayoutChange = useCallback(
    (currentLayout: Layout[]) => {
      onLayoutChange(currentLayout);
    },
    [onLayoutChange]
  );

  return (
    <div ref={containerRef} className="w-full">
      {mounted && (
        <Responsive
          width={width}
          layouts={{ lg: layout.items }}
          breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480 }}
          cols={{ lg: 12, md: 12, sm: 6, xs: 1 }}
          rowHeight={80}
          containerPadding={[16, 16]}
          margin={[12, 12]}
          dragConfig={{ handle: '.drag-handle' }}
          onLayoutChange={handleLayoutChange}
        >
          {children}
        </Responsive>
      )}
    </div>
  );
};

export default WidgetGrid;
