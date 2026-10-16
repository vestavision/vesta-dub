import {describe,it,expect} from 'vitest';
import {AudioContextManager} from '../src/audio/AudioContextManager';
describe('P5.2 original player state restoration',()=>{
 it.each([{volume:0.25,muted:true},{volume:0,muted:false},{volume:0.8,muted:false}])('restores original volume and mute state %j',initial=>{
  const video={...initial} as HTMLVideoElement;
  const audio=new AudioContextManager();audio.attachVideo(video);audio.duckVideo();audio.setDuckingLevel(0.2);audio.unduckVideo();
  expect(video.volume).toBe(initial.volume);expect(video.muted).toBe(initial.muted);
 });
 it('does not undo an intentional mute made while ducked',()=>{
  const video={volume:0.8,muted:false} as HTMLVideoElement;
  const audio=new AudioContextManager();audio.attachVideo(video);audio.duckVideo();video.muted=true;audio.unduckVideo();
  expect(video.volume).toBe(0.8);expect(video.muted).toBe(true);
 });
});
