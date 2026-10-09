"""Original geometric fixtures for compositor demonstration; no external/user media."""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import math, subprocess
root=Path(__file__).resolve().parents[1]; out=root/'examples/timeline-synthetic'; out.mkdir(parents=True,exist_ok=True)
font='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
bold='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
def f(n,b=False): return ImageFont.truetype(bold if b else font,n)
for name,bg,accent,title,number in [('scene-a','#102E37','#D7E9AC','FIRST LIGHT','01'),('scene-b','#24243D','#F0B286','AFTER HOURS','02')]:
    im=Image.new('RGB',(720,1280),bg);d=ImageDraw.Draw(im)
    d.rectangle((42,42,678,1238),outline=accent,width=2)
    for i in range(6):
        r=240+i*44;d.ellipse((360-r,650-r,360+r,650+r),outline=accent,width=2)
    d.ellipse((194,484,526,816),fill=accent)
    d.text((55,70),'FRAME / MULTITRACK STUDY',fill=accent,font=f(21,True))
    d.text((55,122),number,fill=accent,font=f(170,True))
    d.text((80,1040),title,fill=accent,font=f(54,True))
    d.text((80,1120),'ORIGINAL SYNTHETIC TEST MEDIA',fill=accent,font=f(22))
    im.save(out/(name+'.png'))
im=Image.new('RGBA',(360,480),(0,0,0,0));d=ImageDraw.Draw(im)
d.rounded_rectangle((8,8,352,472),radius=28,fill=(218,234,177,242),outline='#FFFFFF',width=4)
points=[]
for i in range(10):
    a=-math.pi/2+i*math.pi/5;r=100 if i%2==0 else 45
    points.append((180+math.cos(a)*r,190+math.sin(a)*r))
d.polygon(points,fill='#23392C')
d.text((34,328),'LAYER 02',font=f(44,True),fill='#23392C')
d.text((37,392),'PICTURE IN PICTURE',font=f(20),fill='#23392C')
im.save(out/'overlay-star.png')
ff=['ffmpeg','-hide_banner','-loglevel','error','-y']
for name,seconds,extra in [('scene-a',4,False),('scene-b',5,True)]:
    args=ff+['-loop','1','-framerate','30','-i',str(out/(name+'.png'))]
    if extra:args+=['-f','lavfi','-i','sine=frequency=660:sample_rate=48000']
    args+=['-vf',"scale=792:1408,crop=720:1280:x='36+30*sin(t)':y=64",'-t',str(seconds),'-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-threads','1']
    if extra:args+=['-af','volume=0.08','-c:a','aac']
    args+=['-movflags','+faststart',str(out/(name+'.mp4'))]
    subprocess.run(args,check=True)
subprocess.run(ff+['-f','lavfi','-i','sine=frequency=220:duration=10:sample_rate=48000','-af','volume=0.18,afade=t=in:d=0.1,afade=t=out:st=9.6:d=0.4','-c:a','pcm_s16le',str(out/'sound-bed.wav')],check=True)
print('Created original timeline synthetic fixtures')
