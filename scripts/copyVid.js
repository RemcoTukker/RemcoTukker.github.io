
/*
TODO
 * Make a proper module of this code
 * Add photo input, will require a second canvas somehow. Maybe make video small / hide video
 * realtime parameter control
 * Optimizations: 
    - (wontfix) do proper memory management
    - (wontfix) when having code for video, properly implement skipping of areas that didnt change
    - ? make the canvas a bit wider so that we dont have to do any bound checking
    - ? if necessary rewrite stuff using asm.js and opengl / webgl
 * See if it is possible to include optic flow and difference masking in optimized code

*/

var inputSelection = document.getElementById("localFiles");
var selectDemo = document.getElementById("demoFile");
var webcam = document.getElementById("webcam");
var video = document.getElementById("source");
var selectImage = document.getElementById("images");
var canvas = document.getElementById("output");
var ctx = canvas.getContext("2d");

var playLocalFile = function(event) {
  var file = this.files[0];
  if (video.canPlayType(file.type) == 'no')  {
    // do nothing
  } else {
    // lets try
    video.src = URL.createObjectURL(file);
  }
};

var useWebcam = function(event) {
    navigator.getUserMedia  = navigator.getUserMedia || navigator.webkitGetUserMedia ||
                              navigator.mozGetUserMedia || navigator.msGetUserMedia;
    navigator.getUserMedia({audio: false, video: true}, function(stream) {
        video.src = window.URL.createObjectURL(stream);
    }, function() {console.log("failed to open webcam"); });
};

var playDemoFile = function(event) {
  video.src = 'YosemiteWonders_Excerpt.ogv';
};


var fillSummedAreaTable = function (w, h, data1, data2, diff, table, gradientx, gradienty) { 
    // these should be two imageData.data arrays with same size
    // diff and table are output, the difference image and the summed area table of the differences
    // also the x and y gradient of the luminoscity image calculated by sobel operators

    // this function is quite fast, only takes a bit longer than the stackblur process, so probably under 15 ms per frame on my pc
    // It may be improved further by operating directly on the buffers or by using asm js. First option is probably best, much 
    // simpler and should give close to optimal performance.

    var r, g, b, i, idx;
    
    // first calculate all differences and already make the luminance image for later
    var l = new Float32Array(data1.length);
    for (idx = 0, i = 0; idx < diff.length; idx++, i = i + 4) {
        r = data1[i]; 
        g = data1[i + 1];  
        b = data1[i + 2]; 
        l[idx] = 0.3*r + 0.59*g + 0.11*b;
        r -= data2[i];
        g -= data2[i + 1];
        b -= data2[i + 2];
        diff[idx] = Math.sqrt(r*r + g*g + b*b);
    }
    
    // then construct the summed area table
    table[0] = diff[0];

    for (var x = 1; x < w; x++) table[x] = table[x-1] + diff[x];
    for (var y = 1; y < h; y++) table[y * w] = table[y * w - w] + diff[y * w];
    for (var x = 1; x < w; x++) {
        for (var y = 1; y < h; y++) {
            idx = y * w + x; 
            table[idx] = diff[idx] + table[idx - 1] - table[idx - w - 1] + table[idx - w];            
        }
    }

    // finally also calculate gradients of data1 with sobel operator
    // we use luminance of a pixel (computed with L(r,g,b) = 0.30*r + 0.59*g + 0.11*b ) that we computed before
    var endidx = w*(h - 1) - 1;
    var p1, p2, p3, p4, p5, p6, p7, p8, gx, gy, norm;
    for (idx = w + 1; idx < endidx; idx++) {  
        // left and right edges will contain invalid data, but i dont care, wont use them, and this is probably faster than skipping over them
        p1 = l[idx - w - 1]; p2 = l[idx - w]; p3 = l[idx - w + 1];
        p4 = l[idx     - 1];                  p5 = l[idx     + 1];
        p6 = l[idx + w - 1]; p7 = l[idx + w]; p8 = l[idx + w + 1];
        gx = p3 + 2*p5 + p8 - p1 - 2*p4 - p6;
        gy = p6 + 2*p7 + p8 - p1 - 2*p2 - p3;
        // and finally normalize
        norm = Math.sqrt(gx*gx + gy*gy);
            // TODO if this is very close to 0 make something up!
        gradientx[idx] = gx / norm;
        gradienty[idx] = gy / norm;

    }

};


var width, height, white, summedDiff, diff, xGradient, yGradient, frame, layer, output; // stuff is initialized in startplay then used in processFrame
var brushSizes, blurringFactor, gridFactor, areaErrorThreshold, maxStrokeLength, minStrokeLength, curvatureFilter, stepFactor;

var makeStroke = function (startX, startY, brushSize) {

    // make sure we dont start too close to border (not really necessary)
    //maxErrorX = Math.max(1, Math.min(maxErrorX, width - 2));
    //maxErrorY = Math.max(1, Math.min(maxErrorY, height - 2));

    var startIdx = (startY * width + startX) * 4;
    var layerdata = layer.data;
    var pointsX = new Array(maxStrokeLength), pointsY = new Array(maxStrokeLength);
    var sr = layerdata[startIdx], sg = layerdata[startIdx + 1], sb = layerdata[startIdx + 2];
    var strokex = startX, strokey = startY;
    var lastDx = 0, lastDy = 0;
    var count;
    for (count = 0; count < maxStrokeLength; count++) {
        pointsX[count] = strokex;
        pointsY[count] = strokey;
        var idx = strokey*width + strokex;
        var idx4 = idx * 4;
        // now propose a new stroke point        
        // get the normal on the gradient here
        var dx = -yGradient[idx];
        var dy = xGradient[idx];
        // check which direction is best
        if (lastDx * dx + lastDy * dy < 0) {
            dx = -dx;
            dy = -dy;
        }        
        // filter stroke direction, make turns more smooth depending on parameter
        dx = curvatureFilter * dx + (1 - curvatureFilter) * lastDx;
        dy = curvatureFilter * dy + (1 - curvatureFilter) * lastDy;
        // make the dx and dy the right length and calculate new coordinates
        strokex += Math.round(dx * brushSize * stepFactor);  
        strokey += Math.round(dy * brushSize * stepFactor); 
        lastDx = dx;
        lastDy = dy;
        // evaluate new coordinates
        var r = layerdata[idx4] - sr, g = layerdata[idx4 + 1] - sg, b = layerdata[idx4 + 2] - sb;
        var newDiff = r*r + g*g + b*b;
        var oldDiff = diff[idx];
        var actualImprovement = oldDiff * oldDiff > newDiff;  // old difference (squared) is bigger than new difference (squared)
             // TODO add a second condition, if color is different enough (another threshold, or maybe reuse areaErrorThreshold)
        var withinFrame = strokex > 0 && strokex < width - 1 && strokey > 0 && strokey < height - 1;
        // bail out if the next point wont be good
        if ( (!withinFrame || (!actualImprovement && count > minStrokeLength)) && count != maxStrokeLength - 1 ) {
            // set a -1 to signal end of stroke
            pointsX[count + 1] = -1;
            break;
        }
    }

    return {r:sr, g:sg, b:sb, pointsX:pointsX, pointsY:pointsY};
}


var makeStrokes = function (gridStep, brushSize) {
    // return variable
    var strokes = [];

    // variables that are used in the loop
    var areaXstart, areaXend, areaYstart, areaYend, areaError, maxError, maxErrorY, maxErrorX, maxErrorIdx;
    var x, y;

    var halfStep = Math.round(gridStep / 2);

    // loop over a grid and at each point check if we should start a stroke
    for (x = halfStep; x < width; x = x + gridStep) {
      for (y = halfStep; y < height; y = y + gridStep) {
        // calculate the error over the local area and also find location of maximum error already
        areaXstart = Math.max(x - halfStep, 0);
        areaXend = Math.min(x + halfStep, width);
        areaYstart = Math.max(y - halfStep, 0);
        areaYend = Math.min(y + halfStep, height);
        var a = areaYstart*width + areaXstart;
        var b = areaYstart*width + areaXend;
        var c = areaYend*width + areaXstart;
        var d = areaYend*width + areaXend;  
        areaError = summedDiff[d] - summedDiff[c] - summedDiff[b] + summedDiff[a];
            // is this exactly right? shouldnt we make sure d != c  and  d != b  ????

        // if the error is too small, no need for adding stroke; continue to next grid location
        // (TODO maybe add an override here if we want background completely filled even if white)
        if (areaError < areaErrorThreshold * (areaXend - areaXstart) * ( areaYend - areaYstart) ) {
            continue;
        }

        // choose a random spot in this grid location to start (note: in the paper they choose the location with max error; TODO?)
        maxErrorX = Math.floor(Math.random() * (areaXend - areaXstart)) + areaXstart;
        maxErrorY = Math.floor(Math.random() * (areaYend - areaYstart)) + areaYstart;
        //maxErrorX = x;
        //maxErrorY = y;

        var newStroke = makeStroke(maxErrorX, maxErrorY, brushSize);
        
        strokes.push(newStroke);
      }
    }
    return strokes;
}

var paint = function (brushSize, idx) {

    stackBlurRGB(layer, width, height, Math.round(brushSize*blurringFactor));  // in-place blurring of current layer
    // TODO just use a box blur based on summed-area table instead of stackblur. also integrate it within next step   

    // precalculate the error between the current image and the blurred reference image
    // we're using a summed area table because we will need the error in a particular area as well
    fillSummedAreaTable(width, height, layer.data, output.data, diff, summedDiff, xGradient, yGradient);

    // calculate the strokes that we want to make
    var gridStep = Math.round(brushSize * gridFactor);
    var strokes = makeStrokes(gridStep, brushSize);


    // execute strokes in random order (directly in context because i dont wanna mess around with imageData objects as
    //  I would have to implement strokes and circles and so on myself, pixel by pixel)
 
    // TODO replace this with webgl rendering, eg with line_strip
    // alternatively, see how setting the data by hand performs...
        // in the end, we may use PIXI or I can make my own implementation of more realistic brush strokes
        // PIXI is a bit overkill though, because we don't need a whole stage


   while (strokes.length > 0) {
        var idx = Math.floor(Math.random() * strokes.length);
        var stroke = strokes.splice(idx, 1)[0];

        if (stroke.pointsX[1] == -1) { // only 1 control point, so we need a circle

        } else {
            // add a first and last point by mirroring TODO
            if (stroke.pointsX[2] == -1 || stroke.pointsX[3] == -1) continue;

            ctx.strokeStyle = "rgb(" + stroke.r + "," + stroke.g + "," + stroke.b + ")";
            ctx.lineWidth = brushSize;
            ctx.lineCap = "round";

           //console.log(stroke);

            // hacky hack form Stack Overflow
            // move to the first point
            ctx.beginPath();
            ctx.moveTo(stroke.pointsX[0], stroke.pointsY[0]);
            for (i = 1; i < stroke.pointsX.length - 2 && stroke.pointsX[i + 3] >= 0; i ++)
            {
              var xc = (stroke.pointsX[i] + stroke.pointsX[i + 1]) / 2;
              var yc = (stroke.pointsY[i] + stroke.pointsY[i + 1]) / 2;
              ctx.quadraticCurveTo(stroke.pointsX[i], stroke.pointsY[i], xc, yc);
            }
            // curve through the last two points
            ctx.quadraticCurveTo(stroke.pointsX[i], stroke.pointsY[i], stroke.pointsX[i+1],stroke.pointsY[i+1]);
            ctx.stroke();
        }
        

    }


    output = ctx.getImageData(0, 0, width, height); // and update the current frame object for next brush size

}

var processFrame = function() {
  if (video.paused || video.ended) return;

  ctx.drawImage(video, 0, 0, width, height);
  frame = ctx.getImageData(0, 0, width, height);


  // create an output frame thats white
  //output.data.set(white);   // TODO once im happy with single frame drawing remove this and check article about movie specific stuff
  ctx.putImageData(output, 0, 0); // TODO when im not using ctx anymore for stroke drawing this one can be removed

    // TODO see if we can actually use multiple canvases, one for each brush size. Might make stuff classier
  for (var b = 0; b < brushSizes.length; b++) {
    layer.data.set(frame.data);
    paint(brushSizes[b], b);
  }

  ctx.putImageData(output, 0, 0); // finally put the output frame back in the canvas
  //  ctx.putImageData(layer, 0, 0); // finally put the output frame back in the canvas

  setTimeout(processFrame, 30);
};


var startPlay = function() {
  canvas.width = video.clientWidth;
  canvas.height = video.clientHeight;

    // some arrays that we're going to use
    width = canvas.width;   
    height = canvas.height;

    frame = ctx.getImageData(0, 0, width, height);
    white = new Uint8ClampedArray(frame.data.length);
    for (var i = 0; i < white.length; i++) { white[i] = 255; }  
    summedDiff = new Float32Array(white.length / 4); // summed area table (enough precision?? seems to work atm, maybe not if canvas is bigger..) 
    diff = new Float32Array(white.length / 4); 
    xGradient = new Float32Array(white.length / 4); 
    yGradient = new Float32Array(white.length / 4); 
    layer = ctx.createImageData(width, height);
    output = ctx.createImageData(width, height);

    //processImageData(output);
    output.data.set(white);

  brushSizes = [10, 5, 2];
  //var brushSizes = [10];
  blurringFactor = 0.5;  // f_sigma
  gridFactor = 1; // f_g
  areaErrorThreshold = 80; // T   euclidian color distance
  maxStrokeLength = 16; // maxLength
  minStrokeLength = 4;  // minLength
  curvatureFilter = 1;  // f_c between 0 and 1
  stepFactor = 0.5;     // new, between 0.1 and 2 or so

  setTimeout(processFrame, 30);
};


inputSelection.addEventListener('change', playLocalFile, false);
webcam.addEventListener('click', useWebcam, false);
selectDemo.addEventListener('click', playDemoFile, false);
video.addEventListener('play', startPlay, false);
