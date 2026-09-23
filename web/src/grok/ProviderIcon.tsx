import {useId} from 'react';
import {Icon} from './ui';
import providerIcons from './provider-icons.json';
export function ProviderIcon({slug}:{slug:string}) {
 const id=useId().replace(/[^a-z0-9]/gi,''),brand=(providerIcons.providers as Record<string,string|null>)[slug]??'',asset=(providerIcons.brands as Record<string,{viewBox:string;svg:string;fillRule?:string}>)[brand];
 return asset?<svg className="ma-provider-icon" data-brand={brand} viewBox={asset.viewBox} fill="currentColor" fillRule={asset.fillRule as 'evenodd'|'nonzero'|undefined} aria-hidden="true" dangerouslySetInnerHTML={{__html:asset.svg.replaceAll('__MA_ICON_PREFIX__',`provider-${id}-`)}}/>:<Icon name={slug==='endpoint'?'link':'grid-sparkle'}/>;
}
