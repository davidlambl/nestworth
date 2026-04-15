import React from 'react';

type Props = {
  value: string;
  onChange: (val: string) => void;
  style?: Record<string, any>;
  colorScheme?: 'light' | 'dark';
};

export default function WebDateInput({ value, onChange, style, colorScheme = 'light' }: Props) {
  return React.createElement('input', {
    type: 'date',
    value,
    onChange: (e: any) => onChange(e.target.value),
    style: {
      fontFamily: 'inherit',
      fontSize: 'inherit',
      padding: 12,
      height: 48,
      borderRadius: 10,
      border: '1px solid',
      outline: 'none',
      boxSizing: 'border-box',
      width: '100%',
      colorScheme,
      cursor: 'pointer',
      ...style,
    },
  });
}
