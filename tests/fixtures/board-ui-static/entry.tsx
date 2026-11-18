import React,{useLayoutEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import BoardUiStatic from '../../../apps/web/src/board-ui/BoardUiStatic.tsx';
import type {BoardPortConnection} from '../../../apps/web/src/board-ui/connection-ports.ts';
import {I18nProvider,createLanguageStore} from '../../../apps/web/src/i18n/I18nProvider.tsx';
import type {Locale} from '../../../packages/i18n/src/index.ts';
import {boardScene,thumbnail} from './scenes.ts';
import '@xyflow/react/dist/style.css';
import './fixture.css';

const language=createLanguageStore({systemLanguages:['zh-Hans']});
const callbacks={connections:[] as BoardPortConnection[],located:[] as string[],added:0};
interface FixtureApi {
  setScenario(value:'sample'|'stress'):void;
  setMotion(value:'normal'|'app'|'prop'):void;
  setLocale(value:Locale):Promise<void>;
  clearCallbacks():void;
  readCallbacks():typeof callbacks;
}
declare global {interface Window {__boardFixture:FixtureApi}}

function Fixture() {
  const [scenario,setScenario]=useState<'sample'|'stress'>('sample');
  const [motion,setMotion]=useState<'normal'|'app'|'prop'>('normal');
  const [selected,setSelected]=useState<string|null>(null);
  const scene=React.useMemo(()=>boardScene(scenario==='stress'),[scenario]);
  useLayoutEffect(()=>{
    document.documentElement.dataset.reduceMotion=motion==='app'?'true':'false';
    window.__boardFixture={
      setScenario(value){setSelected(null);setScenario(value);},setMotion,
      setLocale:language.setPreference,
      clearCallbacks(){callbacks.connections.length=0;callbacks.located.length=0;callbacks.added=0;},
      readCallbacks:()=>structuredClone(callbacks),
    };
  },[motion]);
  return <div className="fixture-shell" data-fixture-scenario={scenario} data-fixture-motion={motion}>
    <header className="fixture-topbar"><span className="fixture-lights"><i/><i/><i/></span><strong>Mioon</strong><span>合成画板</span><div className="fixture-mode"><b>▦ 画板</b><span>▥ 剪辑</span></div><span className="fixture-saved">● 本地 · 已保存</span></header>
    <div className="fixture-workspace">
      <aside className="fixture-assets"><h2>素材 <span>主体</span></h2><div className="fixture-import">↥ 导入素材</div><div className="fixture-search">⌕ 搜索素材</div><div className="fixture-filters">视频 ×　 标签：夜景 ×</div><p>8 项</p><div className="fixture-asset-grid">{Array.from({length:8},(_,index)=><div key={index}><img src={thumbnail(index)} alt=""/><span>scene-{String.fromCharCode(97+index)}.mp4</span></div>)}</div></aside>
      <main className="fixture-board"><BoardUiStatic key={scenario} {...scene} reduceMotion={motion==='prop'} selectedNodeId={selected} onSelectNode={setSelected} onConnect={connection=>callbacks.connections.push(connection)} onLocateNode={id=>callbacks.located.push(id)} onAddShot={()=>callbacks.added++}/></main>
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<I18nProvider store={language}><Fixture/></I18nProvider>);
