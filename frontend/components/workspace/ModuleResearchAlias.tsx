'use client';
import {useEffect} from 'react';
import {useRouter} from 'next/navigation';
import Link from 'next/link';
export function ModuleResearchAlias({target}:{target:'/console/zerodha/research'|'/console/indmoney-us/research'}){const router=useRouter();useEffect(()=>{router.replace(target+window.location.search+window.location.hash);},[target,router]);return <p role="status">Opening the canonical module research screen. No workflow was created. <Link className="underline" href={target}>Continue to research</Link>.</p>;}
