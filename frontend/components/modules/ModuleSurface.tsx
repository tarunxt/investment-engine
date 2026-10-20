'use client';
import {useModules} from '@/providers/ModuleContext';
import {surfaceAllowed} from '@/lib/modulePolicy';
export function ModuleSurface({path,children}:{path:string;children:React.ReactNode}){const {manifest}=useModules();return surfaceAllowed(manifest,path)?children:null;}
