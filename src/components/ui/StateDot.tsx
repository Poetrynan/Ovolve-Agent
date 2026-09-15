/**
 * StateDot — Activity indicator
 * States: working (pulsing), done (filled), failed (red)
 * Used for session activity and turn status
 */

import React from 'react';
import styles from './StateDot.module.css';

export type StateDotState = 'working' | 'done' | 'failed' | 'idle' | 'paused';

interface StateDotProps {
  state: StateDotState;
  size?: number;
  label?: string;
}

export function StateDot({ state, size = 8, label }: StateDotProps) {
  return (
    <span
      className={`${styles.dot} ${styles[state]}`}
      style={{ width: size, height: size }}
      aria-label={label || state}
      title={label || state}
    >
      {state === 'working' && <span className={styles.pulse} />}
    </span>
  );
}

export default StateDot;
