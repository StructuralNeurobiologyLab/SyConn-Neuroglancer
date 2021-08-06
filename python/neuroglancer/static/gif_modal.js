// Get the image
var img1 = document.getElementById("img1");
var img2 = document.getElementById("img2");
var img3 = document.getElementById("img3");
var img4 = document.getElementById("img4");

// Get the modal
var modal = document.getElementById("viewImg");

var modalImg = document.getElementById("modalImg");
var captionText = document.getElementById("caption");

// Handle clicked image and insert gif inside the modal - use its "alt" text as a caption
img1.onclick = function(){
  modal.style.display = "block";
  modalImg.src = "../static/neuro-welcome.gif";
  captionText.innerHTML = this.alt;
}

img2.onclick = function(){
  modal.style.display = "block";
  modalImg.src = "../static/neuro-navigation.gif";
  captionText.innerHTML = this.alt;
}

img3.onclick = function(){
  modal.style.display = "block";
  modalImg.src = "../static/neuro-render.gif";
  captionText.innerHTML = this.alt;
}

img4.onclick = function(){
  modal.style.display = "block";
  modalImg.src = "../static/neuro-welcome.gif";
  captionText.innerHTML = this.alt;
}

// Get the <span> element that closes the modal
var span = document.getElementsByClassName("close")[0];

// When the user clicks on <span> (x), close the modal
span.onclick = function() {
  modal.style.display = "none";
  modal.src = "";
} 


