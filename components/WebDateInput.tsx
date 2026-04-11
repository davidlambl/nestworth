import React from 'react';

type Props = {
  value: string;
  onChange: (val: string) => void;
  style?: Record<string, any>;
};

export default function WebDateInput({ value, onChange, style }: Props) {
  return React.createElement('input', {
    type: 'date',
    value,
    onChange: (e: any) => onChange(e.target.value),
    style: {
      fontFamily: 'inherit',
      fontSize: 'inherit',
      padding: 12,
      borderRadius: 8,
      border: '1px solid',
      outline: 'none',
      boxSizing: 'border-box',
      width: '100%',
      ...style,
    },
  });
}
