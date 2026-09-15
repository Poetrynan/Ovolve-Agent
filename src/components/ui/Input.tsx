/**
 * Input — Text input component
 * 8px border-radius, 32px height
 * Supports label, error, icon, and textarea mode
 */

import React, { forwardRef } from 'react';
import styles from './Input.module.css';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  icon?: React.ReactNode;
  iconPosition?: 'left' | 'right';
  fullWidth?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      hint,
      icon,
      iconPosition = 'left',
      fullWidth = false,
      className = '',
      id,
      ...props
    },
    ref
  ) => {
    const inputId = id || `input-${Math.random().toString(36).slice(2, 9)}`;

    const wrapperClassNames = [
      styles.wrapper,
      fullWidth ? styles.fullWidth : '',
      error ? styles.hasError : '',
      props.disabled ? styles.disabled : '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div className={wrapperClassNames}>
        {label && (
          <label className={styles.label} htmlFor={inputId}>
            {label}
          </label>
        )}
        <div className={styles.inputWrapper}>
          {icon && iconPosition === 'left' && (
            <span className={`${styles.icon} ${styles.iconLeft}`}>{icon}</span>
          )}
          <input
            ref={ref}
            id={inputId}
            className={styles.input}
            aria-invalid={!!error}
            {...props}
          />
          {icon && iconPosition === 'right' && (
            <span className={`${styles.icon} ${styles.iconRight}`}>{icon}</span>
          )}
        </div>
        {error && <span className={styles.error}>{error}</span>}
        {hint && !error && <span className={styles.hint}>{hint}</span>}
      </div>
    );
  }
);

Input.displayName = 'Input';

export default Input;
