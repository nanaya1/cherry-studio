import React from 'react';
const itemHandler = (onSelect, props) => ({
    ...props,
    'data-disabled': props.disabled ? '' : undefined,
    disabled: props.disabled,
    onClick: (event) => onSelect?.(event),
    type: 'button'
});
const SelectContext = React.createContext({});
export const MockCherrystudioUI = {
    Badge: ({ children, ...props }) => <span {...props}>{children}</span>,
    Button: ({ children, loading, ...props }) => {
        void loading;
        return (<button type="button" {...props}>
        {children}
      </button>);
    },
    Checkbox: ({ checked, onCheckedChange, ...props }) => (<button {...props} type="button" role="checkbox" aria-checked={checked === 'indeterminate' ? 'mixed' : Boolean(checked)} onClick={(event) => {
            props.onClick?.(event);
            onCheckedChange?.(!checked);
        }}/>),
    Combobox: ({ options, value, onChange, placeholder, searchPlaceholder, emptyText, ...props }) => {
        void searchPlaceholder;
        void emptyText;
        const selected = options.find((option) => option.value === value);
        return (<div {...props}>
        <button type="button" aria-label={placeholder}>
          {selected ? selected.label : placeholder}
        </button>
        {options.map((option) => (<button type="button" key={option.value} aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
            {option.icon}
            {option.label}
          </button>))}
      </div>);
    },
    ConfirmDialog: ({ cancelText, confirmText, content, contentClassName, description, onConfirm, open, overlayClassName, title }) => open ? (<div role="dialog" className={contentClassName} data-overlay-class={overlayClassName}>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
        {content}
        <button type="button">{cancelText ?? 'Cancel'}</button>
        <button type="button" onClick={onConfirm}>
          {confirmText ?? 'Confirm'}
        </button>
      </div>) : null,
    ContextMenu: ({ children }) => <div data-testid="context-menu">{children}</div>,
    ContextMenuContent: ({ children, className, ...props }) => (<div data-testid="context-menu-content" className={['z-50', className].filter(Boolean).join(' ')} {...props}>
      {children}
    </div>),
    ContextMenuItem: ({ children, onSelect, ...props }) => React.createElement('button', itemHandler(onSelect, props), children),
    ContextMenuItemContent: ({ children, icon, shortcut, ...props }) => (<span {...props}>
      {icon}
      {children}
      {shortcut ? <span>{shortcut}</span> : null}
    </span>),
    ContextMenuSeparator: (props) => <hr data-testid="context-menu-separator" {...props}/>,
    ContextMenuShortcut: ({ children, ...props }) => <span {...props}>{children}</span>,
    ContextMenuSub: ({ children }) => <div>{children}</div>,
    ContextMenuSubContent: ({ children, ...props }) => <div {...props}>{children}</div>,
    ContextMenuSubTrigger: ({ children, ...props }) => (<button type="button" {...props}>
      {children}
    </button>),
    ContextMenuTrigger: ({ children }) => <>{children}</>,
    CustomTag: ({ children, ...props }) => <span {...props}>{children}</span>,
    DescriptionSwitch: ({ checked, description, disabled, label, onCheckedChange, position = 'right' }) => (<label data-position={position}>
      <span>{label}</span>
      {description && <span>{description}</span>}
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(event) => onCheckedChange?.(event.target.checked)}/>
    </label>),
    Dialog: ({ children, open }) => (open ? <>{children}</> : null),
    DialogContent: ({ children, closeOnOverlayClick, showCloseButton, ...props }) => {
        void closeOnOverlayClick;
        void showCloseButton;
        return (<div role="dialog" {...props}>
        {children}
      </div>);
    },
    DialogFooter: ({ children, ...props }) => <div {...props}>{children}</div>,
    DialogHeader: ({ children, ...props }) => <div {...props}>{children}</div>,
    DialogTitle: ({ children, ...props }) => <h2 {...props}>{children}</h2>,
    Divider: (props) => <hr {...props}/>,
    EmptyState: ({ description, title }) => (<div>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
    </div>),
    FieldError: ({ children, ...props }) => <p {...props}>{children}</p>,
    Input: (props) => <input {...props}/>,
    Label: ({ children, ...props }) => <label {...props}>{children}</label>,
    // Content deliberately dropped: a tooltip is not an accessible name, so a trigger that
    // depends on it for meaning is a bug the test should catch, not one the mock hides.
    NormalTooltip: ({ children }) => <>{children}</>,
    RowFlex: ({ children, ...props }) => <div {...props}>{children}</div>,
    Scrollbar: ({ children, ...props }) => <div {...props}>{children}</div>,
    Select: ({ children, onValueChange, value, ...props }) => (<SelectContext.Provider value={{ onValueChange, value }}>
      <div data-testid="select" data-value={value} {...props}>
        {children}
      </div>
    </SelectContext.Provider>),
    SelectDropdown: ({ items, onSelect, renderItem, renderSelected, selectedId, placeholder }) => {
        const selected = items.find((item) => item.id === selectedId);
        return (<div>
        <button type="button" aria-label={placeholder}>
          {selected ? renderSelected(selected) : placeholder}
        </button>
        {items.map((item) => (<button type="button" key={item.id} onClick={() => onSelect(item.id)}>
            {renderItem(item, item.id === selectedId)}
          </button>))}
      </div>);
    },
    SelectContent: ({ children, ...props }) => (<div data-testid="select-content" {...props}>
      {children}
    </div>),
    SelectItem: ({ children, value, ...props }) => {
        const context = React.useContext(SelectContext);
        return (<button {...props} type="button" data-testid="select-item" data-value={value} onClick={(event) => {
                props.onClick?.(event);
                context.onValueChange?.(value);
            }}>
        {children}
      </button>);
    },
    SelectTrigger: ({ children, ...props }) => (<button type="button" data-testid="select-trigger" {...props}>
      {children}
    </button>),
    SelectValue: ({ children, placeholder, ...props }) => (<span data-testid="select-value" {...props}>
      {children ?? placeholder}
    </span>),
    SearchInput: ({ value, onChange, onClear, clearLabel, ...props }) => (<div>
      <input type="search" value={value} onChange={onChange} {...props}/>
      {onClear && clearLabel && value ? <button type="button" aria-label={clearLabel} onClick={onClear}/> : null}
    </div>),
    SegmentedControl: ({ options, value, onValueChange, ...props }) => (<div role="radiogroup" {...props}>
      {options.map((option) => (<button type="button" role="radio" aria-checked={option.value === value} key={option.value} onClick={() => onValueChange(option.value)}>
          {option.label}
        </button>))}
    </div>),
    Skeleton: (props) => <div {...props}/>
};
