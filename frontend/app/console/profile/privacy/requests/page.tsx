import {ConceptFPrivacySurface} from '@/components/workspace/ConceptFPrivacySurface';
export default function PrivacyRequestsPage(){return process.env.NEXT_PUBLIC_UAT2==='true'?<ConceptFPrivacySurface/>:<p>Use the supported privacy controls in your account workspace.</p>;}
