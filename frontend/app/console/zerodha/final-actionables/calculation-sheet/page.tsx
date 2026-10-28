import {IncrementalCalculationSheet} from '@/components/workspace/IncrementalCalculationSheet';
export default function Page(){return process.env.NEXT_PUBLIC_UAT2==='true'?<IncrementalCalculationSheet portfolio="india"/>:<p>This simulation worksheet is unavailable in this environment.</p>;}
