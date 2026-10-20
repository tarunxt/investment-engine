'use client';
import {createContext,useContext} from 'react';
import type {ModuleCollection} from '@/lib/modulePolicy';
type Context={manifest:ModuleCollection|null;loading:boolean;error:string|null;refresh:()=>Promise<void>;save:(id:string,enabled:boolean)=>Promise<void>};
export const ModulesContext=createContext<Context>({manifest:null,loading:true,error:null,refresh:async()=>{},save:async()=>{}});
export const useModules=()=>useContext(ModulesContext);
