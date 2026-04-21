import { type ReactNode } from 'react';
import { ModuleView } from '../components/ModuleView';

export function Stub({ title, hint, children }: { title: string; hint: string; children?: ReactNode }) {
  return (
    <ModuleView title={title}>
      <div className="section">
        <p style={{ color: 'var(--ink-2)', fontFamily: 'var(--mono)', fontSize: 11.5 }}>{hint}</p>
      </div>
      {children}
    </ModuleView>
  );
}
