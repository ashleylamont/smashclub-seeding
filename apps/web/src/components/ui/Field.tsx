import { useId, type ComponentProps, type ReactNode } from 'react';

type Props = Omit<ComponentProps<'input'>, 'children'> & {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
};

/** Labels and validation belong to the field; business validation belongs to its caller. */
export function Field({ label, hint, error, id, className = '', ...props }: Props) {
  const generated = useId();
  const inputId = id ?? generated;
  const descriptions = [
    props['aria-describedby'],
    hint ? `${inputId}-hint` : '',
    error ? `${inputId}-error` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="ui-field">
      <label htmlFor={inputId}>{label}</label>
      <input
        {...props}
        id={inputId}
        className={`input ${className}`}
        aria-describedby={descriptions || undefined}
        aria-invalid={error ? true : props['aria-invalid']}
      />
      {hint && (
        <span className="ui-field-hint" id={`${inputId}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="error-text" id={`${inputId}-error`}>
          {error}
        </span>
      )}
    </div>
  );
}
