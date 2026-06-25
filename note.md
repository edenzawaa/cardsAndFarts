some optimization rules:
1. use THREE.InstancedMesh to render multiple similar object in a single draw call 
2. potentially combine all the sprites of cards and object into one grid images and then shift the texture cordinate  to display the right texture
3. use on demand render, only render when theres a state changes dont use a superloop
4. cap the pixel ratio if needed
5. compressed texture
6. use a text overlay layer to render on top of 3d objects 