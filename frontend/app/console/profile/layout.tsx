import type {ReactNode} from 'react';
import {costAdministratorOwner} from '../_components/adminAccess';
import {ProfileFrame} from './ProfileFrame';
export default async function ProfileLayout({children}:{children:ReactNode}){return <ProfileFrame costAccessOwner={await costAdministratorOwner()}>{children}</ProfileFrame>;}
