// Test-only bounded pre-destination capture. It deliberately emits silence;
// no microphone, physical device or subjective listening result is inferred.
class ContinuousCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const frames=options.processorOptions.frames;
    if(!Number.isInteger(frames)||frames<1||frames>30*48000)throw Error('Synthetic capture exceeds 30 seconds');
    this.left=new Float32Array(frames);this.right=new Float32Array(frames);
    this.frames=0;this.startFrame=null;this.firstSignal=null;this.overflow=false;
    this.port.onmessage=event=>{
      if(event.data!=='capture')return;
      this.port.postMessage({kind:'capture',frames:this.frames,startFrame:this.startFrame,firstSignal:this.firstSignal,overflow:this.overflow,left:this.left,right:this.right},[this.left.buffer,this.right.buffer]);
      this.left=null;this.right=null;
    };
  }
  process(inputs,outputs) {
    if(!this.left)return false;
    if(this.startFrame===null)this.startFrame=currentFrame;
    const count=outputs[0][0].length,input=inputs[0];
    if(this.frames+count>this.left.length){this.overflow=true;return true;}
    for(let at=0;at<count;at++){
      const left=input[0]?.[at]??0,right=input[1]?.[at]??0;
      this.left[this.frames+at]=left;this.right[this.frames+at]=right;
      if(this.firstSignal===null&&(left!==0||right!==0)){
        this.firstSignal=currentFrame+at;this.port.postMessage({kind:'first-signal',contextFrame:this.firstSignal});
      }
    }
    this.frames+=count;return true;
  }
}
registerProcessor('continuous-synthetic-capture',ContinuousCapture);
