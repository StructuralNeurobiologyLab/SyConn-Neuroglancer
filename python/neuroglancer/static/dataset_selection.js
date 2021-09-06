$(document).ready(function(){
    $('#acquisition').on('change', function () {
        $('#version').html('');
    
        if ($('#acquisition').val() == "j0251"){
            $('#version').removeAttr('disabled');
            $('#version').append('<option value="rag_flat_Jan2019_v2">rag_flat_Jan2019_v2</option>');
            $('#version').append('<option value="rag_flat_Jan2019_v3">rag_flat_Jan2019_v3</option>');
    
        } else if ($('#acquisition').val() == "j0126") {
            $('#version').attr('disabled', 'disabled');

        } else if ($('#acquisition').val() == "example_cube") {
            $('#version').removeAttr('disabled');
            $('#version').append('<option value="">1</option>');
            $('#version').append('<option value="">2</option>');
            $('#version').append('<option value="">3</option>');
            
        } else {
            $('#version').removeAttr('disabled');
            $('#version').append('<option value="">Select an acquisition from the above dropdown first</option>');
        }
    
        if ($('#version').val()) {
            $('#submit').removeAttr('disabled');
        } else {
            $('#submit').attr('disabled', 'disabled');
        }
    });

    $('#submit').on('click', function () {
        var $this = $(this);
        $this.addClass('buttonload');
        $('i').addClass('fa fa-refresh fa-spin');
        $this.text('Loading...');
    });
});