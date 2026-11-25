import type {ReactNode} from "react";

export function WorkflowBasketButton({ready,onClick,children}:{ready:boolean;onClick:()=>void;children:ReactNode}) {
  return <button type="button" onClick={onClick}
    className={`mx-auto mt-3 block min-h-12 max-w-full rounded-lg px-8 text-base font-semibold text-white ${ready ? "bg-green-700 hover:bg-green-800" : "bg-blue-700 hover:bg-blue-800"}`}>{children}</button>;
}
