import { Component, type ReactNode } from "react";

export class TaskMonitorErrorBoundary extends Component<{children:ReactNode},{error:Error|null}> {
  state={error:null as Error|null};
  static getDerivedStateFromError(error:Error){return {error};}
  render(){
    if(!this.state.error)return this.props.children;
    return <main className="task-monitor-boot" role="alert"><div><h2>页面暂时无法显示</h2><p>请重新加载页面；任务和已提交的指示仍会保留。</p><button type="button" onClick={()=>window.location.reload()}>重新加载</button><details><summary>查看错误信息</summary><p>{this.state.error.message}</p></details></div></main>;
  }
}
