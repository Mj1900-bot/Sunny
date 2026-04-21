import { type ReactNode } from 'react';
import { toolbarCaption } from '../styles';

export type ToolbarGroupProps = {
  caption: string;
  children: ReactNode;
};

export function ToolbarGroup({ caption, children }: ToolbarGroupProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <span style={toolbarCaption}>{caption}</span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {children}
      </div>
    </div>
  );
}
