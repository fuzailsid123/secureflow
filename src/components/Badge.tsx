import type { ReactNode } from 'react';
import type { TaskState } from '@/lib/types';

export type Tone = 'blue' | 'green' | 'red' | 'amber' | 'violet' | 'gray';

export function Badge({ tone = 'gray', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

const stateTone: Record<TaskState, Tone> = {
  pending: 'gray',
  running: 'blue',
  completed: 'green',
  quarantined: 'red',
  cancelled: 'gray',
};

export function StateBadge({ state }: { state: TaskState }) {
  return <Badge tone={stateTone[state]}>{state}</Badge>;
}
