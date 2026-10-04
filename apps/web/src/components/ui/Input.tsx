import type { ComponentProps } from 'react';

/** Text, number and file inputs keep the browser's editing and form semantics. */
export function Input({ className = '', ...props }: ComponentProps<'input'>) {
  return <input {...props} className={`input ${className}`} />;
}

export function Textarea({ className = '', ...props }: ComponentProps<'textarea'>) {
  return <textarea {...props} className={`textarea ${className}`} />;
}
