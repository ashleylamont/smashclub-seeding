import {
  Children,
  Fragment,
  isValidElement,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import * as Primitive from '@radix-ui/react-select';

const EMPTY_ITEM = '__ui_empty_option__';
type Props = Omit<
  ComponentProps<typeof Primitive.Trigger>,
  'value' | 'defaultValue' | 'onChange'
> & {
  value?: string | number;
  defaultValue?: string | number;
  onValueChange?: (value: string) => void;
  name?: string;
  required?: boolean;
  placeholder?: ReactNode;
};

function emptyLabel(children: ReactNode): ReactNode {
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ value?: string | number; children?: ReactNode }>(child)) continue;
    if (child.type === SelectItem && child.props.value === '') return child.props.children;
    if (child.type === Fragment) {
      const label = emptyLabel(child.props.children);
      if (label != null) return label;
    }
  }
  return undefined;
}

/** Values and callbacks use domain strings, including a selectable empty option. */
export function Select({
  value,
  defaultValue = '',
  onValueChange,
  children,
  className = '',
  name,
  required,
  disabled,
  placeholder,
  ...props
}: Props) {
  const [localValue, setLocalValue] = useState(String(defaultValue));
  return (
    <Primitive.Root
      value={value === undefined ? localValue : String(value)}
      onValueChange={(next) => {
        const result = next === EMPTY_ITEM ? '' : next;
        setLocalValue(result);
        onValueChange?.(result);
      }}
      name={name}
      required={required}
      disabled={disabled}
    >
      <Primitive.Trigger
        {...props}
        data-value={value === undefined ? localValue : String(value)}
        className={`select ui-select ${className}`}
      >
        <Primitive.Value placeholder={placeholder ?? emptyLabel(children) ?? 'Choose…'} />
        <Primitive.Icon className="ui-select-icon">▾</Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          className="ui-select-content"
          position="popper"
          sideOffset={4}
          collisionPadding={8}
        >
          <Primitive.ScrollUpButton className="ui-select-scroll">▴</Primitive.ScrollUpButton>
          <Primitive.Viewport>{children}</Primitive.Viewport>
          <Primitive.ScrollDownButton className="ui-select-scroll">▾</Primitive.ScrollDownButton>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

export function SelectItem({
  value,
  children,
  ...props
}: Omit<ComponentProps<typeof Primitive.Item>, 'value'> & { value: string | number }) {
  return (
    <Primitive.Item
      {...props}
      value={value === '' ? EMPTY_ITEM : String(value)}
      data-value={String(value)}
      className="ui-select-item"
    >
      <Primitive.ItemText>{children}</Primitive.ItemText>
      <Primitive.ItemIndicator className="ui-select-check">✓</Primitive.ItemIndicator>
    </Primitive.Item>
  );
}
