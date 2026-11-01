import {Button as ButtonPrimitive} from '@base-ui/react/button';

type ButtonVariant='default'|'outline'|'ghost';
type ButtonSize='default'|'sm'|'icon';

const variantClass:Record<ButtonVariant,string>={default:'k-btn-default',outline:'k-btn-outline',ghost:'k-btn-ghost'};
const sizeClass:Record<ButtonSize,string>={default:'k-btn-md',sm:'k-btn-sm',icon:'k-btn-icon'};

/** Nova-shaped button on Base UI. Visuals live in ui.css. */
function Button({className,variant='ghost',size='default',...props}:ButtonPrimitive.Props & {variant?:ButtonVariant;size?:ButtonSize}){
 const classes=['k-btn',variantClass[variant],sizeClass[size],className].filter(Boolean).join(' ');
 return <ButtonPrimitive data-slot="button" className={classes} {...props}/>;
}

export {Button};
