import {ConceptFLegacySetup} from '@/components/workspace/ConceptFLegacySetup';
export default function Page(){return process.env.NEXT_PUBLIC_UAT2==='true'?<ConceptFLegacySetup/>:<p>Legacy setup preview is unavailable in this runtime.</p>;}
