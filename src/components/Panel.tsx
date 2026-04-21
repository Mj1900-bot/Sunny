import type { ReactNode, CSSProperties } from 'react';

type Props = {
  id: string;
  title: string;
  right?: ReactNode;
  // Extra node rendered in the panel header AFTER the `right` text slot,
  // outside the `<small>` wrapper. Use this for crisp icon-buttons whose
  // color / size shouldn't inherit the dim small-tag styling applied by
  // `.panel h3 small` in sunny.css.
  headerExtra?: ReactNode;
  children: ReactNode;
  bodyPad?: number | string;
  bodyStyle?: CSSProperties;
};

export function Panel({ id, title, right, headerExtra, children, bodyPad = 12, bodyStyle }: Props) {
  return (
    <div className="panel" id={id}>
      <div className="c1" aria-hidden="true" />
      <div className="c2" aria-hidden="true" />
      <h3>
        {title}
        {right !== undefined && <small>{right}</small>}
        {headerExtra}
      </h3>
      <div className="body" style={{ padding: bodyPad, ...bodyStyle }}>{children}</div>
    </div>
  );
}
