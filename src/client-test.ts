import {PSNavClient} from './psnav-client';
const nav = new PSNavClient('http://clio.local:3050');

nav.on('button', (evt) => console.log(evt.button, evt.pressed));
nav.on('axis', (evt) => console.log(evt.axis, evt.value));

nav.connect();