"use client";
import {useCallback, useEffect, useState} from "react";
import {boardApi, boardChanged, type Board} from "@/lib/scorecardBoard";
import type {apiService} from "@/services/api";

export function useScorecardBoard(client:typeof apiService) {
  const [board,setBoard]=useState<Board|null>(null);
  const [issue,setIssue]=useState("");
  const [refresh,setRefresh]=useState(0);
  const reload=useCallback(()=>setRefresh(n=>n+1),[]);
  useEffect(()=>{
    let current=true;
    boardApi(client).read().then(b=>{if(current){setBoard(b);setIssue("");}})
      .catch(e=>{if(current){setBoard(null);setIssue(String(e));}});
    return ()=>{current=false;};
  },[client,refresh]);
  useEffect(()=>{
    window.addEventListener(boardChanged,reload);window.addEventListener("focus",reload);
    return ()=>{window.removeEventListener(boardChanged,reload);window.removeEventListener("focus",reload);};
  },[reload]);
  return {board,issue,reload};
}
