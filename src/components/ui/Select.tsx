import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Icon, IconName } from './Icon';
import styles from './Select.module.css';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  subtitle?: string;
  icon?: IconName;
}

interface SelectProps<T extends string = string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  placement?: 'top' | 'bottom';
  align?: 'left' | 'right';
  icon?: IconName;
  title?: string;
}

export function Select<T extends string = string>({
  value,
  options,
  onChange,
  placement = 'top',
  align = 'right',
  icon,
  title,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((o) => o.value === value) || options[0];

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const handleSelect = useCallback(
    (optValue: T) => {
      onChange(optValue);
      setOpen(false);
    },
    [onChange]
  );

  return (
    <div className={styles.container} ref={containerRef}>
      {/* Pill Trigger */}
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerActive : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {(selectedOption?.icon || icon) && (
          <span className={styles.triggerIcon}>
            <Icon name={selectedOption?.icon || icon!} size={14} />
          </span>
        )}
        <span className={styles.triggerLabel}>{selectedOption?.label || value}</span>
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}>
          <Icon name="chevron-down" size={12} />
        </span>
      </button>

      {/* Popover Menu */}
      {open && (
        <div
          className={`${styles.dropdown} ${placement === 'bottom' ? styles.dropdownDown : ''} ${align === 'left' ? styles.dropdownLeft : styles.dropdownRight}`}
          role="listbox"
        >
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                className={`${styles.option} ${isSelected ? styles.optionSelected : ''}`}
                onClick={() => handleSelect(opt.value)}
                role="option"
                aria-selected={isSelected}
              >
                {opt.icon && (
                  <span className={styles.optionIcon}>
                    <Icon name={opt.icon} size={14} />
                  </span>
                )}
                <div className={styles.optionInfo}>
                  <span className={styles.optionTitle}>{opt.label}</span>
                  {opt.subtitle && (
                    <span className={styles.optionSubtitle}>{opt.subtitle}</span>
                  )}
                </div>
                {isSelected && (
                  <span className={styles.checkIcon}>
                    <Icon name="check" size={14} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default Select;
